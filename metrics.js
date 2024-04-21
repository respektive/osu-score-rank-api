const express = require("express");
const client = require("prom-client");

const app = express();

const requestDurationHistogram = new client.Histogram({
    name: "score_rank_api_request_duration_histogram",
    help: "Histogram of HTTP request durations in seconds",
    labelNames: ["method", "route", "status_code", "origin", "mode"],
});

const dbQueryDurationHistogram = new client.Histogram({
    name: "score_rank_api_db_query_duration_histogram",
    help: "Histogram of database query durations in seconds",
    labelNames: ["query"],
});

const osuApiRequestDurationHistogram = new client.Histogram({
    name: "score_rankings_fetcher_osu_api_request_duration_histogram",
    help: "Histogram of osu api request durations in seconds",
    labelNames: ["mode", "status_code"],
});

function observeRequestDuration(duration, method, route, statusCode, origin, mode) {
    requestDurationHistogram.labels(method, route, statusCode, origin, mode).observe(duration);
}

function observeDbQueryDuration(duration, query) {
    dbQueryDurationHistogram.labels(query).observe(duration);
}

function observeOsuApiRequestDuration(duration, mode, statusCode) {
    osuApiRequestDurationHistogram.labels(mode, statusCode).observe(duration);
}

const collectDefaultMetrics = client.collectDefaultMetrics;
const Registry = client.Registry;
const register = new Registry();
collectDefaultMetrics({ register });

register.registerMetric(requestDurationHistogram);
register.registerMetric(dbQueryDurationHistogram);
register.registerMetric(osuApiRequestDurationHistogram);

function metricsServer(port) {
    app.get("/metrics", async (req, res) => {
        res.set("Content-Type", register.contentType);
        res.send(await register.metrics());
    });

    app.listen(port, () => {
        console.log(`metrics server started on port ${port}`);
    });
}

module.exports = {
    metricsServer,
    observeDbQueryDuration,
    observeRequestDuration,
    observeOsuApiRequestDuration,
};
