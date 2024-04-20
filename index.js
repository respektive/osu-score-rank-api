const axios = require("axios");
const Redis = require("ioredis");
const redisClient = new Redis();
const config = require("./config");
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

let token;
let entries = 0;
let refresh = 0;
let user_ids = [];
let retries = {
    osu: {
        score: 0,
    },
    mania: {
        score: 0,
    },
    taiko: {
        score: 0,
    },
    fruits: {
        score: 0,
    },
};
let done = true;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function refreshToken() {
    return new Promise((resolve, reject) => {
        axios({
            url: "https://osu.ppy.sh/oauth/token",
            method: "post",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            data: {
                grant_type: "client_credentials",
                client_id: config.osu.id,
                client_secret: config.osu.secret,
                scope: "public",
            },
        })
            .then((data) => {
                refresh = Date.now() + data.data.expires_in * 1000;
                resolve("Bearer " + data.data.access_token);
            })
            .catch((err) => {
                reject(err);
            });
    });
}

async function fullRankingsUpdate(mode, type, cursor) {
    let conn;
    if (Date.now() > refresh - 5 * 60 * 1000) {
        token = await refreshToken();
    }

    let osuAPI = axios.create({
        baseURL: "https://osu.ppy.sh/api/v2",
        headers: { Authorization: token },
        json: true,
    });

    osuAPI
        .get("/rankings/" + mode + "/" + type, { data: { cursor: { page: cursor } } })
        .then(async (res) => {
            let i = 0;

            console.log("Adding " + res.data.ranking.length + " Entries to the db");

            await res.data.ranking.forEach(async (elem) => {
                i++;
                entries++;
                user_ids.push(elem.user.id);

                await redisClient.zadd(`score_${mode}`, elem.ranked_score, elem.user.id);
                await redisClient.hset("user_id_to_username", elem.user.id, elem.user.username);
                await redisClient.hset("username_to_user_id", elem.user.username, elem.user.id);
                try {
                    conn = await pool.getConnection();
                    const rows = await conn.query(
                        "SELECT rank FROM osu_score_rank_highest WHERE user_id = ? AND mode = ?",
                        [elem.user.id, MODES[mode]]
                    );

                    const rank = await redisClient.zrevrank(`score_${mode}`, elem.user.id);
                    if (!rows[0] || rank + 1 < rows[0].rank) {
                        const res = await conn.query(
                            "INSERT INTO osu_score_rank_highest (user_id, mode, rank) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE rank=?",
                            [elem.user.id, MODES[mode], rank + 1, rank + 1]
                        );
                        console.log(
                            "Added new highest rank",
                            rank + 1,
                            "for user",
                            elem.user.username,
                            "and mode",
                            mode
                        );
                    }
                } finally {
                    if (conn) conn.end();
                }
            });

            if (res.data.cursor != null) {
                cursor = res.data.cursor.page;
                await sleep(1000);
                fullRankingsUpdate(mode, type, cursor);
                retries[mode][type] = 0;
                console.log("Added a total of " + entries + " to the db score_" + mode);
            } else {
                // Remove restricted and otherwise deleted users from the api.
                const redis_users = await redisClient.zrange(`score_${mode}`, 0, -1);
                for (id of redis_users) {
                    if (!user_ids.includes(Number(id))) {
                        await redisClient.zrem(`score_${mode}`, id);
                        console.log("Removed user_id:", id);
                    }
                }
                console.log("Finished iterating for a total of " + entries + " Entries!");
                entries = 0;
                user_ids = [];
                done = true;
            }
        })
        .catch(async (err) => {
            if (retries[mode][type] < 4) {
                console.log(err);
                console.log("Retry: " + retries[mode][type]);
                retries[mode][type]++;
                await sleep(1000 * (retries[mode][type] * 10));
                fullRankingsUpdate(mode, type, cursor);
            } else {
                console.log("Max retries reached, giving up.");
                retries[mode][type] = 0;
                done = true;
            }
        });
}

let m = -1;

function updateAll() {
    if (!done) {
        console.log("fetching not done yet, waiting for next interval.");
        return;
    }

    m++;
    if (m > 3) {
        m = 0;
    }

    switch (m) {
        default:
        case 0:
            fullRankingsUpdate("osu", "score", 1);
            done = false;
            console.log("Starting fetch for osu!");
            break;
        case 1:
            fullRankingsUpdate("taiko", "score", 1);
            done = false;
            console.log("Starting fetch for osu!taiko");
            break;
        case 2:
            fullRankingsUpdate("fruits", "score", 1);
            done = false;
            console.log("Starting fetch for osu!catch");
            break;
        case 3:
            fullRankingsUpdate("mania", "score", 1);
            done = false;
            console.log("Starting fetch for osu!mania");
            break;
    }
}

async function main() {
    updateAll();
    setInterval(updateAll, 480 * 1000);
}

main();
