const express = require("express");
const Redis = require("ioredis");
const redisClient = new Redis();
const config = require("./config");
const { metricsServer, observeDbQueryDuration, observeRequestDuration } = require("./metrics");
const {
	getPeakRank,
	getRankHistory,
	isStringInteger,
	isEmpty,
	resolveModeName,
	guessOriginFromRequestHeaders,
	MAX_USERS_PER_REQUEST
} = require("./helpers");
const responseTime = require("response-time");
const mariadb = require("mariadb");
const pool = mariadb.createPool({
	host: config.db.host,
	user: config.db.user,
	password: config.db.pw,
	database: config.db.db,
	connectionLimit: 5
});

const api = express();
const port = config.api.port;

async function getUserAtRank(rank, mode) {
	const rankUser = await redisClient.zrevrange(`score_${mode}`, rank - 1, rank - 1, "WITHSCORES");

	if (!rankUser?.length) return {};

	const userId = rankUser[0];
	const rankHighestMap = await getPeakRank([userId], mode);
	const rankHistoryMap = await getRankHistory([userId], mode);

	return {
		rank: parseInt(rank),
		user_id: parseInt(userId),
		username: await redisClient.hget("user_id_to_username", userId),
		score: parseInt(rankUser[1]),
		rank_highest: rankHighestMap[userId] ?? null,
		rank_history: rankHistoryMap[userId] ?? null
	};
}

async function main() {
	api.listen(port, () => console.log(`api listening on port ${port}`));

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
				resolveModeName(req.query.mode, req.query.m)
			);
		})
	);

	api.get("/rank/:rank", async (req, res) => {
		const mode = resolveModeName(req.query.mode, req.query.m);
		const rank = req.params.rank;
		if (!isStringInteger(rank)) {
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
		const mode = resolveModeName(req.query.mode, req.query.m);
		const scores = req.query.score?.split(",") ?? [];
		// FIXME: The deduplication here means the scores array can desync from userIds - low prio since specifying the same id multiple ids is an user error anyway
		const users = [...new Set(req.params.users.split(","))];
		if (users.length > MAX_USERS_PER_REQUEST) {
			res.status(400);
			res.json({ error: `Too many users. The limit is ${MAX_USERS_PER_REQUEST}.` });
			return;
		}

		if (!["username", "user_id"].includes(req.query.s)) req.query.s = "user_id";

		const userIds = [];
		for (const user of users) {
			const userId = req.query.s == "username" ? await redisClient.hget("username_to_user_id", user) : user;

			if (!isStringInteger(userId)) {
				res.status(400);
				res.json({ error: "Invalid User" });
				return;
			}

			userIds.push(userId);
		}

		const rankHighestMap = await getPeakRank(userIds, mode);
		const rankHistoryMap = await getRankHistory(userIds, mode);

		const results = [];
		for (const [index, userId] of userIds.entries()) {
			const rankHighest = rankHighestMap[userId] ?? null;
			const rankHistory = rankHistoryMap[userId] ?? null;
			const username = await redisClient.hget("user_id_to_username", userId);

			let score, rank;
			if (scores[index] != undefined) {
				if (!isStringInteger(scores[index])) {
					res.status(400);
					res.json({ error: "Invalid Score" });
					return;
				}

				score = scores[index];
				const belowRankUser = await redisClient.zrange(`score_${mode}`, score, 0, "BYSCORE", "REV", "LIMIT", 0, 1);
				const belowRank =
					belowRankUser.length == 0 ? 10000 : await redisClient.zrevrank(`score_${mode}`, belowRankUser);
				rank = belowRank;
			} else {
				score = await redisClient.zscore(`score_${mode}`, userId);
				rank = await redisClient.zrevrank(`score_${mode}`, userId);
			}

			const nextRaw = rank == 0 ? null : await getUserAtRank(rank, mode);
			const next = isEmpty(nextRaw)
				? null
				: {
						username: nextRaw.username,
						user_id: nextRaw.user_id,
						score: nextRaw.score
					};

			let prevRaw;
			for (let i = 0; i <= 1; i++) {
				prevRaw = await getUserAtRank(rank + 1 + i, mode);
				if (prevRaw.user_id != parseInt(userId)) break;
			}

			const prev = isEmpty(prevRaw)
				? null
				: {
						username: prevRaw.username,
						user_id: prevRaw.user_id,
						score: prevRaw.score
					};

			const data = {
				rank: rank == null ? 0 : rank + 1,
				user_id: parseInt(userId) || 0,
				username: username || 0,
				score: parseInt(score) || 0,
				rank_highest: rankHighest,
				rank_history: rankHistory,
				prev,
				next
			};
			results.push(data);
		}

		res.status(200);
		res.json(results);
	});

	api.get("/rankings", async (req, res) => {
		const mode = resolveModeName(req.query.mode, req.query.m);
		const page = (isStringInteger(req.query.page) && req.query.page <= 200 && req.query.page >= 1) ? req.query.page : 1;

		const startRank = (page - 1) * 50;
		const rankings = await redisClient.zrevrange(`score_${mode}`, startRank, startRank + 49, "WITHSCORES");

		const lb = {};
		const userIds = [];
		for (let i = 0; i < rankings.length; i += 2) userIds.push(rankings[i]);

		const rankHighestMap = await getPeakRank(userIds, mode);
		const rankHistoryMap = await getRankHistory(userIds, mode);

		let r = 0;
		for (let i = 0; i < rankings.length; i += 2) {
			const userId = rankings[i];
			lb[r] = {};
			lb[r]["rank"] = (await redisClient.zrevrank(`score_${mode}`, userId)) + 1;
			lb[r]["user_id"] = parseInt(userId);
			lb[r]["username"] = await redisClient.hget("user_id_to_username", userId);
			lb[r]["score"] = parseInt(rankings[i + 1]);
			lb[r]["rank_highest"] = rankHighestMap[userId] ?? null;
			lb[r]["rank_history"] = rankHistoryMap[userId] ?? null;
			r++;
		}

		res.status(200);
		res.json(lb);
	});
}

main();

if (config.metrics.port > 0) metricsServer(config.metrics.port);

require("./fetcher");
