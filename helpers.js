const config = require("./config");
const mariadb = require("mariadb");
const { observeDbQueryDuration } = require("./metrics");

const pool = mariadb.createPool({
  host: config.db.host,
  user: config.db.user,
  password: config.db.pw,
  database: config.db.db,
  connectionLimit: 5,
});

const MS_IN_DAY = 1000 * 60 * 60 * 24;
const MAX_USERS_PER_REQUEST = 100;

const MODE_NAMES = ["osu", "taiko", "fruits", "mania"];
const MODE_ENUM = {
  osu: 0,
  taiko: 1,
  fruits: 2,
  mania: 3,
};

function resolveModeName(mode, m) {
  if (m == null)
    return !MODE_NAMES.includes(mode) ? "osu" : mode;
  
  switch (m) {
    case "0":
      return "osu";
    case "1":
      return "taiko";
    case "2":
      return "fruits";
    case "3":
      return "mania";
    default:
      return "osu";
  }
}

function resolveModeId(mode) {
  if (typeof mode === "number") return mode;
  return MODE_ENUM[mode] ?? 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function guessOriginFromRequestHeaders(req) {
  // if its set its probably a browser, also osu subdivide nations extension usually has this set
  if (req.get("referer")) return "browser";

  const userAgent = req.get("user-agent");
  if (!userAgent) return "other";

  if (userAgent.startsWith("Mozilla")) return "browser";
  switch (userAgent) {
    case "flowabot":
      return "flowabot";
    case "bathbot-client":
      return "bathbot";
    // this isnt ideal, but osu-tracker isnt using any custom headers, so we can just assume by the user agent
    case "axios/0.27.2":
    case "osu-tracker":
      return "osu-tracker";
    default:
      return "other";
  }
}

function isStringInteger(str) {
  if (typeof str != "string") return false;
  return !isNaN(str) && !isNaN(parseFloat(str)) && parseFloat(str) == parseInt(str, 10);
}

function isEmpty(object) {
  for (const property in object) return false;
  return true;
}

async function getUserRankHistories(userIds, mode) {
  if (!userIds?.length) return {};

  let conn;
  const startTime = process.hrtime();
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT user_id, rank_history, latest_rank_date FROM osu_score_rank_history WHERE user_id IN (?) AND mode = ?`,
      [userIds, resolveModeId(mode)]
    );

    const result = {};
    for (const row of rows)
      result[row.user_id] = row;
    return result;
  } finally {
    conn?.end();
    const endTime = process.hrtime(startTime);
    const duration = endTime[0] + endTime[1] / 1e9;
    observeDbQueryDuration(duration, "getUserRankHistories");
  }
}

async function getPeakRank(userIds, mode) {
  if (!userIds?.length) return {};

  let conn;
  const startTime = process.hrtime();
  try {
    conn = await pool.getConnection();
    const rows = await conn.query(
      `SELECT user_id, rank, achieved_at FROM osu_score_rank_highest WHERE user_id IN (?) AND mode = ?`,
      [userIds, resolveModeId(mode)]
    );

    const result = {};
    for (const id of userIds)
      result[id] = null;

    for (const row of rows) {
      result[row.user_id] = {
        rank: row.rank,
        updated_at: row.achieved_at,
      };
    }
    return result;
  } finally {
    conn?.end();
    const endTime = process.hrtime(startTime);
    const duration = endTime[0] + endTime[1] / 1e9;
    observeDbQueryDuration(duration, "getPeakRank");
  }
}

async function getRankHistory(userIds, mode) {
  if (!userIds?.length) return {};

  const rows = await getUserRankHistories(userIds, mode);
  const result = {};
  for (const id of userIds) {
    const row = rows[id];
    if (!row?.rank_history || !row.latest_rank_date) {
      result[id] = null;
      continue;
    }

    const rank_history = [];
    const current_date = new Date(row.latest_rank_date);
    for (let i = row.rank_history.length - 1; i >= 0; i--) {
      rank_history.push({
        rank: row.rank_history[i],
        date: current_date.toISOString(),
      });
      current_date.setDate(current_date.getDate() - 1);
    }
    result[id] = rank_history;
  }
  return result;
}

module.exports = {
  guessOriginFromRequestHeaders,
  isStringInteger,
  isEmpty,
  sleep,
  resolveModeName,
  resolveModeId,
  getUserRankHistories,
  getPeakRank,
  getRankHistory,
  MAX_USERS_PER_REQUEST,
  MS_IN_DAY,
  MODE_ENUM,
  MODE_NAMES
};
