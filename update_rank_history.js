const Redis = require("ioredis");
const redisClient = new Redis();
const config = require("./config");
const { getUserRankHistories, MS_IN_DAY, MODE_NAMES } = require("./helpers");
const mariadb = require("mariadb");
const pool = mariadb.createPool({
    host: config.db.host,
    user: config.db.user,
    password: config.db.pw,
    database: config.db.db,
    connectionLimit: 15,
})

async function updateRankHistory() {
    const today = new Date().setHours(0, 0, 0, 0);
    let conn;
    try {
        conn = await pool.getConnection();
        for (let i = 0; i < MODE_NAMES.length; i++) {
            const users = await redisClient.zrevrange(`score_${MODE_NAMES[i]}`, 0, -1);
            const rows = await getUserRankHistories(users, i);
            for (const [index, user_id] of users.entries()) {
                const row = rows[user_id];

                let rank_history;
                if (!row?.latest_rank_date) {
                    rank_history = [];
                } else {
                    const days_since_last_update = Math.floor(
                        (today - new Date(Date.parse(row.latest_rank_date)).setHours(0, 0, 0, 0)) / MS_IN_DAY,
                    );

                    if (days_since_last_update >= 90) {
                        // if the last update was over 90 days ago we can just reset the rank history
                        rank_history = [];
                    } else if (days_since_last_update < 1) {
                        // this should never happen, but doesn't hurt to have as a safety guard i guess?
                        continue;
                    } else {
                        rank_history = row.rank_history;
                        // set days without data to null
                        for (let j = 1; j < days_since_last_update; j++) {
                            rank_history.push(null);
                        }
                    }
                }

                rank_history.push(index + 1);
                // we only wanna store the last 90 days
                while (rank_history.length > 90) rank_history.shift();

                const res = await conn.query(
                    "INSERT INTO osu_score_rank_history (user_id, mode, rank_history) VALUES (?, ?, json_compact(?)) ON DUPLICATE KEY UPDATE rank_history=json_compact(?)",
                    [user_id, i, JSON.stringify(rank_history), JSON.stringify(rank_history)],
                );
            }
        }
    } finally {
        if (conn) await conn.release();
    }
}

(async () => {
    await updateRankHistory();
    console.log("done updating rank history");
    process.exit(0);
})();
