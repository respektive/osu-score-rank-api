const express = require("express");
const client = require("prom-client");

const app = express();

const requestDurationHistogram = new client.Histogram({
    name: "score_rank_api_request_duration_histogram",
    help: "Histogram of HTTP request durations in seconds",
    labelNames: ["method", "route", "status_code", "origin", "mode"],
});

function metricsServer(port) {
    const collectDefaultMetrics = client.collectDefaultMetrics;
    const Registry = client.Registry;
    const register = new Registry();
    collectDefaultMetrics({ register });

    register.registerMetric(requestDurationHistogram);

    app.get("/metrics", async (req, res) => {
        res.set("Content-Type", register.contentType);
        res.send(await register.metrics());
    });

    app.listen(port, () => {
        console.log(`metrics server started on port ${port}`);
    });
}

module.exports = { metricsServer, requestDurationHistogram };
