const Redis = require("ioredis");
const redisClient = new Redis();
const config = require("./config");
const mariadb = require("mariadb");
const pool = mariadb.createPool({
    host: config.db.host,
    user: config.db.user,
    password: config.db.pw,
    database: config.db.db,
    connectionLimit: 15,
});

const MODES = ["osu", "taiko", "fruits", "mania"];

async function updateRankHistory() {
    const today = new Date();
    let conn;
    try {
        conn = await pool.getConnection();
        for (let i = 0; i < 4; i++) {
            const users = await redisClient.zrevrange(`score_${MODES[i]}`, 0, -1);
            for (const [index, user_id] of users.entries()) {
                const rows = await conn.query(
                    "SELECT rank_history, updated_at FROM osu_score_rank_history WHERE user_id = ? AND mode = ? ",
                    [user_id, i]
                );

                let rank_history;
                if (!rows[0]?.updated_at) {
                    rank_history = [];
                } else {
                    const days_since_last_update = Math.floor(
                        (today - Date.parse(rows[0].updated_at)) / (1000 * 60 * 60 * 24)
                    );
                    if (days_since_last_update >= 90) {
                        // if the last update was over 90 days ago we can just reset the rank history
                        rank_history = [];
                    } else {
                        rank_history = rows[0].rank_history;
                        // set days without data to null
                        for (let j = 0; j < days_since_last_update; j++) {
                            rank_history.push(null);
                        }
                    }
                }

                rank_history.push(index + 1);
                // we only wanna store the last 90 days
                while (rank_history.length > 90) rank_history.shift();

                const res = await conn.query(
                    "INSERT INTO osu_score_rank_history (user_id, mode, rank_history) VALUES (?, ?, json_compact(?)) ON DUPLICATE KEY UPDATE rank_history=json_compact(?)",
                    [user_id, i, JSON.stringify(rank_history), JSON.stringify(rank_history)]
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
