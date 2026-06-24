const Redis = require("ioredis");
const redisClient = new Redis();
const config = require("./config");
const { sleep, MODE_ENUM } = require("./helpers");
const { observeDbQueryDuration, observeOsuApiRequestDuration } = require("./metrics");
const mariadb = require("mariadb");
const pool = mariadb.createPool({
	host: config.db.host,
	user: config.db.user,
	password: config.db.pw,
	database: config.db.db,
	connectionLimit: 5
});

const API_URL = "https://osu.ppy.sh/api/v2";
const AUTH_URL = "https://osu.ppy.sh/oauth/token";

const retries = {
	osu: {
		score: 0
	},
	mania: {
		score: 0
	},
	taiko: {
		score: 0
	},
	fruits: {
		score: 0
	}
};
let token;
let entries = 0;
let refresh = 0;
let user_ids = [];
let done = true;

function buildRankingApiUrl(mode, type, cursor_string) {
	const url = new URL(`${API_URL}/rankings/${mode}/${type}`);
	cursor_string && url.searchParams.set("cursor_string", cursor_string);
	return url;
}

async function refreshToken() {
	return new Promise((resolve, reject) => {
		fetch(AUTH_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				grant_type: "client_credentials",
				client_id: config.osu.id,
				client_secret: config.osu.secret,
				scope: "public"
			})
		})
			.then(res => {
				if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${res.statusText}`);

				res
					.json()
					.then(data => {
						refresh = Date.now() + data.expires_in * 1000;
						resolve("Bearer " + data.access_token);
					})
					.catch(reject);
			})
			.catch(reject);
	});
}

async function fullRankingsUpdate(mode, type, cursor_string) {
	let conn;
	if (Date.now() > refresh - 5 * 60 * 1000) token = await refreshToken();

	const osuAPIStartTime = process.hrtime();
	fetch(buildRankingApiUrl(mode, type, cursor_string), {
		headers: { Authorization: token }
	})
		.then(res => {
			if (!res.ok) throw new Error(`API request failed: ${res.status} ${res.statusText}`);

			res
				.json()
				.then(async data => {
					const osuAPIEndTime = process.hrtime(osuAPIStartTime);
					const osuAPIDuration = osuAPIEndTime[0] + osuAPIEndTime[1] / 1e9;
					observeOsuApiRequestDuration(osuAPIDuration, mode, res.status);

					let i = 0;

					await data.ranking.forEach(async elem => {
						i++;
						entries++;

						const { id, username } = elem.user;
						user_ids.push(id);

						await redisClient.zadd(`score_${mode}`, elem.ranked_score, id);
						await redisClient.hset("user_id_to_username", id, username);
						await redisClient.hset("username_to_user_id", username, id);
						try {
							conn = await pool.getConnection();

							// save full user_data to db
							const insertUserDataStartTime = process.hrtime();
							const user_data = elem;
							const res = await conn.query(
								"INSERT INTO osu_score_user_data (user_id, mode, user_data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_data=?, updated_at=current_timestamp()",
								[id, MODE_ENUM[mode], user_data, user_data]
							);

							const insertUserDataEndTime = process.hrtime(insertUserDataStartTime);
							const insertUserDataDuration = insertUserDataEndTime[0] + insertUserDataEndTime[1] / 1e9;
							observeDbQueryDuration(insertUserDataDuration, "insertUserData");

							// check for new peak rank
							const selectStartTime = process.hrtime();
							const rows = await conn.query("SELECT rank FROM osu_score_rank_highest WHERE user_id = ? AND mode = ?", [
								id,
								MODE_ENUM[mode]
							]);

							const selectEndTime = process.hrtime(selectStartTime);
							const duration = selectEndTime[0] + selectEndTime[1] / 1e9;
							observeDbQueryDuration(duration, "getPeakRank");

							const rank = await redisClient.zrevrank(`score_${mode}`, id);
							if (!rows[0] || rank + 1 < rows[0].rank) {
								const insertStartTime = process.hrtime();

								const res = await conn.query(
									"INSERT INTO osu_score_rank_highest (user_id, mode, rank) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE rank=?",
									[id, MODE_ENUM[mode], rank + 1, rank + 1]
								);

								const insertEndTime = process.hrtime(insertStartTime);
								const duration = insertEndTime[0] + insertEndTime[1] / 1e9;
								observeDbQueryDuration(duration, "insertPeakRank");
							}
						} finally {
							conn?.end();
						}
					});

					if (data.cursor_string != null) {
						cursor_string = data.cursor_string;
						await sleep(1000);
						fullRankingsUpdate(mode, type, cursor_string);
						retries[mode][type] = 0;
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
				.catch(err => {
					handleRankingApiError(err, mode, type, cursor_string, osuAPIStartTime);
				});
		})
		.catch(err => {
			handleRankingApiError(err, mode, type, cursor_string, osuAPIStartTime);
		});
}

async function handleRankingApiError(err, mode, type, cursor_string, osuAPIStartTime) {
	const osuAPIEndTime = process.hrtime(osuAPIStartTime);
	const osuAPIDuration = osuAPIEndTime[0] + osuAPIEndTime[1] / 1e9;

	observeOsuApiRequestDuration(osuAPIDuration, mode, err.response?.status || "Unknown");

	if (retries[mode][type] < 4) {
		console.log(err);
		console.log("Retry: " + retries[mode][type]);
		retries[mode][type]++;
		await sleep(1000 * (retries[mode][type] * 10));
		fullRankingsUpdate(mode, type, cursor_string);
	} else {
		console.log("Max retries reached, giving up.");
		retries[mode][type] = 0;
		done = true;
	}
}

let m = -1;

function updateAll() {
	if (!done) {
		console.log("fetching not done yet, waiting for next interval.");
		return;
	}

	m++;
	if (m > 3) m = 0;

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

function startFetch() {
	if (!config.osu.enable_fetch) return;
	updateAll();
	setInterval(updateAll, 480 * 1000);
}

startFetch();
