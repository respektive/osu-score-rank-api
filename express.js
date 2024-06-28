const express = require("express");
const morgan = require("morgan");
const Redis = require("ioredis");
const redisClient = new Redis();
const config = require("./config");
const { metricsServer, observeDbQueryDuration, observeRequestDuration } = require("./metrics");
const responseTime = require("response-time");
const mariadb = require("mariadb");
const pool = mariadb.createPool({
    host: config.db.host,
    user: config.db.user,
    password: config.db.pw,
    database: config.db.db,
    connectionLimit: 5,
});

const MODES = {
    osu: 0,
    taiko: 1,
    fruits: 2,
    mania: 3,
};

const api = express();
const port = config.api.port;

function parseMode(mode, m) {
    let resolveMode = "";

    if (m == undefined) {
        if (["osu", "mania", "taiko", "fruits"].includes(mode) == -1 || mode == undefined) {
            resolveMode = "osu";
        } else {
            resolveMode = mode;
        }
    } else {
        switch (m) {
            case "0":
                resolveMode = "osu";
                break;
            case "1":
                resolveMode = "taiko";
                break;
            case "2":
                resolveMode = "fruits";
                break;
            case "3":
                resolveMode = "mania";
                break;
            default:
                resolveMode = "osu";
                break;
        }
    }
    return resolveMode;
}

function guessOriginFromRequestHeaders(req) {
    if (req.get("referer")) {
        // if its set its probably a browser, also osu subdivide nations extension usually has this set
        return "browser";
    }
    const userAgent = req.get("user-agent");
    if (userAgent) {
        if (userAgent.startsWith("Mozilla")) return "browser";
        switch (userAgent) {
            case "flowabot":
                return "flowabot";
            case "bathbot-client":
                return "bathbot";
            // this isnt ideal, but osu-tracker isnt using any custom headers, so we can just assume by the user agent
            case "axios/0.27.2":
                return "osu-tracker";
            default:
                return "other";
        }
    }
    return "other";
}

function isNumeric(str) {
    if (typeof str != "string") return false;
    return !isNaN(str) && !isNaN(parseFloat(str));
}

function isEmpty(object) {
    for (const property in object) {
        return false;
    }
    return true;
}

async function getPeakRank(user_id, mode) {
    let conn, rows;
    const startTime = process.hrtime();
    try {
        conn = await pool.getConnection();
        rows = await conn.query(
            "SELECT * FROM osu_score_rank_highest WHERE user_id = ? AND mode = ?",
            [user_id, MODES[mode]]
        );
    } finally {
        if (conn) conn.end();
    }
    const endTime = process.hrtime(startTime);
    const duration = endTime[0] + endTime[1] / 1e9;
    observeDbQueryDuration(duration, "getPeakRank");

    let rank_highest = rows[0]?.rank
        ? { rank: rows[0].rank, updated_at: rows[0].updated_at }
        : null;
    return rank_highest;
}

async function getRankHistory(user_id, mode) {
    let conn, rows;
    const startTime = process.hrtime();
    try {
        conn = await pool.getConnection();
        rows = await conn.query(
            "SELECT * FROM osu_score_rank_history WHERE user_id = ? AND mode = ?",
            [user_id, MODES[mode]]
        );
    } finally {
        if (conn) conn.end();
    }

    const endTime = process.hrtime(startTime);
    const duration = endTime[0] + endTime[1] / 1e9;
    observeDbQueryDuration(duration, "getRankHistory");

    if (!rows[0]?.rank_history || !rows[0]?.updated_at) {
        return null;
    }

    let rank_history = [];

    let current_date = new Date(rows[0].updated_at);
    for (let i = rows[0].rank_history.length - 1; i >= 0; i--) {
        rank_history.push({
            rank: rows[0].rank_history[i],
            date: current_date.toISOString(),
        });

        // subtract 1 day from date
        current_date.setDate(current_date.getDate() - 1);
    }

    return rank_history;
}

async function getUserAtRank(rank, mode) {
    let rank_user = await redisClient.zrevrange(
        `score_${mode}`,
        rank - 1,
        rank - 1,
        "WITHSCORES"
    );

    let data = {};

    for (let i = 0; i < rank_user.length; i += 2) {
        data["rank"] = parseInt(rank);
        data["user_id"] = parseInt(rank_user[i]);
        data["username"] = await redisClient.hget("user_id_to_username", rank_user[i]);
        data["score"] = parseInt(rank_user[i + 1]);
        data["rank_highest"] = await getPeakRank(rank_user[i], mode);
        data["rank_history"] = await getRankHistory(rank_user[i], mode);
    }

    return data;
}


async function main() {
    api.listen(port, () => {
        console.log(`api listening on port ${port}`);
    });

    // api.use(morgan("dev"));
    api.use(require("express-status-monitor")());

    api.use(
        responseTime((req, res, response_time) => {
            if (!req?.route?.path) return;

            observeRequestDuration(
                response_time / 1000,
                req.method,
                req.route.path,
                res.statusCode,
                guessOriginFromRequestHeaders(req),
                parseMode(req.query.mode, req.query.m)
            );
        })
    );

    api.get("/rank/*", async (req, res) => {
        let mode = parseMode(req.query.mode, req.query.m);

        let rank = req.path.split("/").pop();

        if (!isNumeric(rank)) {
            res.status(400);
            res.json({ error: "Invalid Rank" });
            return;
        }

        const data = await getUserAtRank(rank, mode);

        if (isEmpty(data)) {
            res.status(200);
            res.json([{ rank: 0, user_id: 0, username: 0, score: 0 }]);
        } else {
            res.status(200);
            res.json([data]);
        }
    });

    api.get("/u/:users", async (req, res) => {
        let mode = parseMode(req.query.mode, req.query.m);
        let users = req.params.users.split(",");
        let scores = req.query.score?.split(",") ?? [];

        if (["username", "user_id"].includes(req.query.s) == -1 || req.query.s == undefined) {
            req.query.s = "user_id";
        }

        let results = [];

        if (users.length > 100) {
            res.status(400);
            res.json({ error: "Too many users. Max limit is 100." });
            return;
        }

        for (const [index, user] of users.entries()) {
            let user_id;
            if (req.query.s == "username") {
                user_id = await redisClient.hget("username_to_user_id", user);
            } else {
                user_id = user;
            }

            if (!isNumeric(user_id)) {
                res.status(400);
                res.json({ error: "Invalid User" });
                return;
            }

            let rank_highest = await getPeakRank(user_id, mode);
            let rank_history = await getRankHistory(user_id, mode);

            let username = await redisClient.hget("user_id_to_username", user_id);

            let score, rank;

            if (scores[index] !== undefined) {
                const userScore = Number(scores[index]);

                if (isNaN(userScore)) {
                    res.status(400);
                    res.json({ error: "Invalid Score" });
                    return;
                }

                score = userScore;

                const belowRankUser = await redisClient.zrange(`score_${mode}`, score, 0, 'BYSCORE', 'REV', 'LIMIT', 0, 1);
                const belowRank = await redisClient.zrevrank(`score_${mode}`, belowRankUser);

                rank = belowRank - 1;
            } else {
                score = await redisClient.zscore(`score_${mode}`, user_id);
                rank = await redisClient.zrevrank(`score_${mode}`, user_id)
            }

            const prevRaw = await getUserAtRank(rank, mode);
            const nextRaw = await getUserAtRank(rank + 2, mode);

            const prev = isEmpty(prevRaw) ? null : { 
                    username: prevRaw.username,
                    user_id: prevRaw.user_id,
                    score: prevRaw.score
            };

            const next = isEmpty(nextRaw) ? null : { 
                    username: nextRaw.username,
                    user_id: nextRaw.user_id,
                    score: nextRaw.score
            };

            let data = {
                rank: rank == null ? 0 : rank + 1,
                user_id: parseInt(user_id) || 0,
                username: username || 0,
                score: parseInt(score) || 0,
                rank_highest: rank_highest,
                rank_history: rank_history,
                prev,
                next
            };
            results.push(data);
        }

        res.status(200);
        res.json(results);
    });

    api.get("/rankings", async (req, res) => {
        let mode = parseMode(req.query.mode, req.query.m);

        if (
            req.query.page > 200 ||
            req.query.page < 1 ||
            req.query.page == undefined ||
            isNaN(req.query.page)
        ) {
            req.query.page = 1;
        }

        let start_rank = (req.query.page - 1) * 50;
        let rankings = await redisClient.zrevrange(
            `score_${mode}`,
            start_rank,
            start_rank + 49,
            "WITHSCORES"
        );

        let lb = {};
        let r = 0;

        for (let i = 0; i < rankings.length; i += 2) {
            lb[r] = {};
            lb[r]["rank"] = (await redisClient.zrevrank(`score_${mode}`, rankings[i])) + 1;
            lb[r]["user_id"] = parseInt(rankings[i]);
            lb[r]["username"] = await redisClient.hget("user_id_to_username", rankings[i]);
            lb[r]["score"] = parseInt(rankings[i + 1]);
            lb[r]["rank_highest"] = await getPeakRank(rankings[i], mode);
            lb[r]["rank_history"] = await getRankHistory(rankings[i], mode);
            r++;
        }

        res.status(200);
        res.json(lb);
    });
}

main();
if (config.metrics.port > 0) {
    metricsServer(config.metrics.port);
}
require("./fetcher");
