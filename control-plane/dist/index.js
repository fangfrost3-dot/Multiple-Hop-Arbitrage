import { createServer } from "node:http";
import { loadBootstrapPools } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { ExecutorClient } from "./executor.js";
import { createLogger } from "./logger.js";
import { loadPoolConfig } from "./poolConfig.js";
import { loadRouteConfig } from "./routeConfig.js";
import { PoolStream } from "./poolStream.js";
import { RustBridge } from "./rustBridge.js";
const config = loadConfig(process.env);
const log = createLogger("control-plane");
const rust = new RustBridge(config.RUST_BINARY);
const poolConfig = await loadPoolConfig(config.POOL_CONFIG_PATH);
const stream = new PoolStream(config, poolConfig);
const routes = await loadRouteConfig(config.ROUTE_CONFIG_PATH).catch(() => []);
const executor = new ExecutorClient(config, routes);
let lastHealth = { tracked_pools: 0, tracked_cycles: 0, latest_block: 0 };
rust.on("ready", () => {
    void bootstrap().catch((error) => {
        log.error({ error }, "bootstrap failed");
        process.exitCode = 1;
    });
});
rust.on("health", (health) => {
    lastHealth = health;
    log.info({ health }, "engine health");
});
rust.on("candidate", async (candidate) => {
    const profit = BigInt(candidate.expected_profit);
    if (profit < config.MIN_EXPECTED_PROFIT) {
        return;
    }
    await executor.handleCandidate(candidate);
});
stream.on("pool_update", (update) => {
    rust.updatePool(update);
});
void stream.connect().catch((error) => {
    log.error({ error }, "pool stream failed to start");
    process.exitCode = 1;
});
setInterval(() => {
    void executor.rebroadcastInflight().catch((error) => {
        log.error({ error }, "executor rebroadcast loop failed");
    });
}, 15_000);
createServer((request, response) => {
    if (request.url === "/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, engine: lastHealth, executor: executor.status() }));
        return;
    }
    if (request.url === "/status") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ engine: lastHealth, executor: executor.status() }));
        return;
    }
    if (request.url === "/metrics") {
        const status = executor.status();
        const lines = [
            "# HELP rn_executor_paused Whether the executor is paused.",
            "# TYPE rn_executor_paused gauge",
            `rn_executor_paused ${status.paused ? 1 : 0}`,
            "# HELP rn_executor_submitted_total Submitted execution transactions.",
            "# TYPE rn_executor_submitted_total counter",
            `rn_executor_submitted_total ${status.metrics.submitted}`,
            "# HELP rn_executor_submitted_public_total Submitted execution transactions via public RPC.",
            "# TYPE rn_executor_submitted_public_total counter",
            `rn_executor_submitted_public_total ${status.metrics.submittedPublic}`,
            "# HELP rn_executor_submitted_relay_total Submitted execution transactions via private relay.",
            "# TYPE rn_executor_submitted_relay_total counter",
            `rn_executor_submitted_relay_total ${status.metrics.submittedRelay}`,
            "# HELP rn_executor_confirmed_total Confirmed execution transactions.",
            "# TYPE rn_executor_confirmed_total counter",
            `rn_executor_confirmed_total ${status.metrics.confirmed}`,
            "# HELP rn_executor_reverted_total Reverted execution transactions.",
            "# TYPE rn_executor_reverted_total counter",
            `rn_executor_reverted_total ${status.metrics.reverted}`,
            "# HELP rn_executor_dropped_total Dropped execution transactions.",
            "# TYPE rn_executor_dropped_total counter",
            `rn_executor_dropped_total ${status.metrics.dropped}`,
            "# HELP rn_executor_replaced_total Replaced execution transactions.",
            "# TYPE rn_executor_replaced_total counter",
            `rn_executor_replaced_total ${status.metrics.replaced}`,
            "# HELP rn_executor_risk_rejected_total Candidates rejected by risk controls.",
            "# TYPE rn_executor_risk_rejected_total counter",
            `rn_executor_risk_rejected_total ${status.metrics.riskRejected}`,
            "# HELP rn_executor_consecutive_failures Consecutive failed executions.",
            "# TYPE rn_executor_consecutive_failures gauge",
            `rn_executor_consecutive_failures ${status.metrics.consecutiveFailures}`,
            "# HELP rn_executor_total_failures Total failed executions.",
            "# TYPE rn_executor_total_failures counter",
            `rn_executor_total_failures ${status.metrics.totalFailures}`,
            "# HELP rn_executor_inflight Pending execution transactions.",
            "# TYPE rn_executor_inflight gauge",
            `rn_executor_inflight ${status.metrics.inflight}`,
            "# HELP rn_executor_cumulative_estimated_net_wei Cumulative estimated net result for wrapped-native executions.",
            "# TYPE rn_executor_cumulative_estimated_net_wei gauge",
            `rn_executor_cumulative_estimated_net_wei ${status.cumulativeEstimatedNetWei}`,
            "# HELP rn_engine_tracked_pools Pools tracked by the Rust engine.",
            "# TYPE rn_engine_tracked_pools gauge",
            `rn_engine_tracked_pools ${lastHealth.tracked_pools}`,
            "# HELP rn_engine_tracked_cycles Cycles tracked by the Rust engine.",
            "# TYPE rn_engine_tracked_cycles gauge",
            `rn_engine_tracked_cycles ${lastHealth.tracked_cycles}`,
            "# HELP rn_engine_latest_block Latest block processed by the Rust engine.",
            "# TYPE rn_engine_latest_block gauge",
            `rn_engine_latest_block ${lastHealth.latest_block}`,
        ];
        response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        response.end(`${lines.join("\n")}\n`);
        return;
    }
    if (request.method === "POST" && request.url === "/resume") {
        void executor.resume().then(() => {
            response.writeHead(202, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: true, executor: executor.status() }));
        }).catch((error) => {
            log.error({ error }, "executor resume failed");
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: false }));
        });
        return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
}).listen(config.METRICS_PORT, () => {
    log.info({ port: config.METRICS_PORT }, "metrics server listening");
});
async function bootstrap() {
    log.info("rust engine ready; loading configured pools");
    const pools = await loadBootstrapPools({
        rpcUrl: config.RPC_URL,
        multicall3Address: config.MULTICALL3_ADDRESS,
        pools: poolConfig,
    });
    rust.bootstrap(pools);
}
