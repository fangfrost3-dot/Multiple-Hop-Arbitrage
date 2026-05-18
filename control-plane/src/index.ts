import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { loadBootstrapPools } from "./bootstrap.js";
import { CandidateNotifier } from "./candidateNotifier.js";
import { loadConfig } from "./config.js";
import { CuMeter } from "./cuMeter.js";
import { ExecutorClient } from "./executor.js";
import { createLogger } from "./logger.js";
import { loadPoolConfig } from "./poolConfig.js";
import { RpcMonitor } from "./rpcMonitor.js";
import { loadRouteConfig } from "./routeConfig.js";
import { PoolStream } from "./poolStream.js";
import { RustBridge } from "./rustBridge.js";

const here = dirname(fileURLToPath(import.meta.url));
const envPaths = [resolve(here, "../../.env"), resolve(here, "../.env")];
for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

const config = await loadConfig(process.env);
const log = createLogger("control-plane");
const cuMeter = new CuMeter();
const rust = new RustBridge(config.RUST_BINARY);
const poolConfig = await loadPoolConfig(config.POOL_CONFIG_PATH);
const stream = new PoolStream(config, poolConfig, cuMeter);
const routes = await loadRouteConfig(config.ROUTE_CONFIG_PATH);
const executor = new ExecutorClient(config, routes, cuMeter);
const candidateNotifier = new CandidateNotifier(config);
const rpcMonitor = new RpcMonitor(config, cuMeter);
let lastHealth = { tracked_pools: 0, tracked_cycles: 0, latest_block: 0 };
const streamStats = {
  poolUpdatesTotal: 0,
  lastUpdateAt: 0,
  lastUpdateBlock: 0,
  lastUpdateSource: "",
  lastUpdatePoolId: "",
};
const bootstrapState: {
  status: "pending" | "running" | "ready" | "failed";
  attempts: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  nextRetryAt?: number;
} = {
  status: "pending",
  attempts: 0,
};
let bootstrapInFlight = false;
let bootstrapRetryTimer: NodeJS.Timeout | undefined;
rpcMonitor.start();

setInterval(() => {
  rust.healthcheck();
}, 5_000).unref();

rust.on("ready", () => {
  scheduleBootstrap();
});

rust.on("health", (health) => {
  lastHealth = health;
  log.info({ health }, "engine health");
});

rust.on("candidate", async (candidate) => {
  const startedAt = performance.now();
  const profit = BigInt(candidate.expected_profit);
  const hasRoute = executor.hasRoute(candidate.cycle_id);
  log.info(
    {
      cycleId: candidate.cycle_id,
      expectedProfit: candidate.expected_profit,
      borrowAmount: candidate.borrow_amount,
      touchedPools: candidate.touched_pools,
      hasRoute,
    },
    "candidate received from rust",
  );
  void candidateNotifier.notifyCandidate(candidate, {
    hasRoute,
    minExpectedProfit: config.MIN_EXPECTED_PROFIT.toString(),
  });
  if (profit < config.MIN_EXPECTED_PROFIT) {
    log.info(
      {
        cycleId: candidate.cycle_id,
        expectedProfit: candidate.expected_profit,
        minExpectedProfit: config.MIN_EXPECTED_PROFIT.toString(),
      },
      "candidate skipped below min expected profit gate",
    );
    return;
  }
  await executor.handleCandidate(candidate);
  log.info(
    {
      cycleId: candidate.cycle_id,
      totalCandidateHandlingMs: Math.round((performance.now() - startedAt) * 100) / 100,
    },
    "candidate handled by control plane",
  );
});

stream.on("pool_update", (update) => {
  streamStats.poolUpdatesTotal += 1;
  streamStats.lastUpdateAt = Date.now();
  streamStats.lastUpdateBlock = update.block_number;
  streamStats.lastUpdateSource = update.source ?? "unknown";
  streamStats.lastUpdatePoolId = update.pool_id;
  rust.updatePool(update);
});

void stream.connect().catch((error: unknown) => {
  log.error({ error }, "pool stream failed to start");
  process.exitCode = 1;
});

setInterval(() => {
  void executor.rebroadcastInflight().catch((error: unknown) => {
    log.error({ error }, "executor rebroadcast loop failed");
  });
}, 15_000);

if (config.EXECUTOR_KILL_SWITCH_PATH) {
  setInterval(() => {
    if (!config.EXECUTOR_KILL_SWITCH_PATH) {
      return;
    }
    if (!existsSync(config.EXECUTOR_KILL_SWITCH_PATH)) {
      return;
    }

    void executor.pauseManual(`kill switch file present at ${config.EXECUTOR_KILL_SWITCH_PATH}`).catch((error: unknown) => {
      log.error({ error }, "executor kill switch pause failed");
    });
  }, 5_000).unref();
}

createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, ...statusPayload() }));
    return;
  }

  if (request.url === "/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(statusPayload()));
    return;
  }

  if (request.url === "/metrics") {
    const status = executor.status();
    const rpc = rpcMonitor.snapshot();
    const stream = streamStatus(rpc);
    const cu = cuMeter.snapshot();
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
      "# HELP rn_stream_pool_updates_total Pool updates forwarded from the control-plane stream to Rust.",
      "# TYPE rn_stream_pool_updates_total counter",
      `rn_stream_pool_updates_total ${stream.poolUpdatesTotal}`,
      "# HELP rn_stream_last_update_age_ms Milliseconds since the most recent pool update.",
      "# TYPE rn_stream_last_update_age_ms gauge",
      `rn_stream_last_update_age_ms ${stream.lastUpdateAgeMs ?? 0}`,
      "# HELP rn_stream_last_update_block Last block observed in a forwarded pool update.",
      "# TYPE rn_stream_last_update_block gauge",
      `rn_stream_last_update_block ${stream.lastUpdateBlock ?? 0}`,
      "# HELP rn_stream_public_block_lag Public RPC head minus last forwarded pool update block.",
      "# TYPE rn_stream_public_block_lag gauge",
      `rn_stream_public_block_lag ${stream.publicBlockLag ?? 0}`,
      "# HELP rn_rpc_public_healthy Whether the public RPC probe is healthy.",
      "# TYPE rn_rpc_public_healthy gauge",
      `rn_rpc_public_healthy ${rpc.publicRpc.healthy ? 1 : 0}`,
      "# HELP rn_rpc_public_latency_ms Last successful public RPC latency in milliseconds.",
      "# TYPE rn_rpc_public_latency_ms gauge",
      `rn_rpc_public_latency_ms ${rpc.publicRpc.lastLatencyMs ?? 0}`,
      "# HELP rn_rpc_public_consecutive_failures Consecutive public RPC probe failures.",
      "# TYPE rn_rpc_public_consecutive_failures gauge",
      `rn_rpc_public_consecutive_failures ${rpc.publicRpc.consecutiveFailures}`,
      "# HELP rn_rpc_public_latest_block Latest block reported by the public RPC probe.",
      "# TYPE rn_rpc_public_latest_block gauge",
      `rn_rpc_public_latest_block ${rpc.publicRpc.latestBlock ?? 0}`,
      "# HELP rn_rpc_relay_healthy Whether the relay RPC probe is healthy.",
      "# TYPE rn_rpc_relay_healthy gauge",
      `rn_rpc_relay_healthy ${rpc.relayRpc.healthy ? 1 : 0}`,
      "# HELP rn_rpc_relay_latency_ms Last successful relay RPC latency in milliseconds.",
      "# TYPE rn_rpc_relay_latency_ms gauge",
      `rn_rpc_relay_latency_ms ${rpc.relayRpc.lastLatencyMs ?? 0}`,
      "# HELP rn_rpc_relay_consecutive_failures Consecutive relay RPC probe failures.",
      "# TYPE rn_rpc_relay_consecutive_failures gauge",
      `rn_rpc_relay_consecutive_failures ${rpc.relayRpc.consecutiveFailures}`,
      "# HELP rn_rpc_relay_latest_block Latest block reported by the relay RPC probe.",
      "# TYPE rn_rpc_relay_latest_block gauge",
      `rn_rpc_relay_latest_block ${rpc.relayRpc.latestBlock ?? 0}`,
      "# HELP rn_alchemy_estimated_cu_total Estimated Alchemy compute units used since this process started.",
      "# TYPE rn_alchemy_estimated_cu_total counter",
      `rn_alchemy_estimated_cu_total ${cu.estimatedTotalCu}`,
      "# HELP rn_alchemy_estimated_cu_per_hour Estimated Alchemy compute units per hour based on this process run.",
      "# TYPE rn_alchemy_estimated_cu_per_hour gauge",
      `rn_alchemy_estimated_cu_per_hour ${cu.estimatedCuPerHour}`,
      "# HELP rn_alchemy_estimated_cu_per_month Estimated Alchemy compute units per 30 days based on this process run.",
      "# TYPE rn_alchemy_estimated_cu_per_month gauge",
      `rn_alchemy_estimated_cu_per_month ${cu.estimatedCuPerMonth}`,
      "# HELP rn_alchemy_websocket_bytes_total Estimated websocket subscription payload bytes received.",
      "# TYPE rn_alchemy_websocket_bytes_total counter",
      `rn_alchemy_websocket_bytes_total ${cu.websocketBytes}`,
      "# HELP rn_alchemy_websocket_events_total Websocket subscription events received.",
      "# TYPE rn_alchemy_websocket_events_total counter",
      `rn_alchemy_websocket_events_total ${cu.websocketEvents}`,
    ];

    response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    response.end(`${lines.join("\n")}\n`);
    return;
  }

  if (request.method === "POST" && request.url === "/resume") {
    void executor.resume().then(() => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, executor: executor.status() }));
    }).catch((error: unknown) => {
      log.error({ error }, "executor resume failed");
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
    });
    return;
  }

  if (request.method === "POST" && request.url === "/pause") {
    void executor.pauseManual("manual pause via HTTP").then(() => {
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, executor: executor.status() }));
    }).catch((error: unknown) => {
      log.error({ error }, "executor pause failed");
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

function statusPayload() {
  const rpc = rpcMonitor.snapshot();
  return {
    engine: lastHealth,
    controlPlane: {
      bootstrap: {
        ...bootstrapState,
        inFlight: bootstrapInFlight,
      },
    },
    stream: streamStatus(rpc),
    executor: executor.status(),
    rpc,
    alchemyCu: cuMeter.snapshot(),
  };
}

function streamStatus(rpc: ReturnType<RpcMonitor["snapshot"]>) {
  const lastUpdateAgeMs = streamStats.lastUpdateAt > 0 ? Date.now() - streamStats.lastUpdateAt : undefined;
  const publicBlockLag =
    streamStats.lastUpdateBlock > 0 && rpc.publicRpc.latestBlock !== undefined
      ? Math.max(0, rpc.publicRpc.latestBlock - streamStats.lastUpdateBlock)
      : undefined;

  return {
    poolUpdatesTotal: streamStats.poolUpdatesTotal,
    lastUpdateAt: streamStats.lastUpdateAt > 0 ? streamStats.lastUpdateAt : undefined,
    lastUpdateAgeMs,
    lastUpdateBlock: streamStats.lastUpdateBlock > 0 ? streamStats.lastUpdateBlock : undefined,
    lastUpdateSource: streamStats.lastUpdateSource || undefined,
    lastUpdatePoolId: streamStats.lastUpdatePoolId || undefined,
    publicBlockLag,
  };
}

async function bootstrap(): Promise<void> {
  log.info("rust engine ready; loading configured pools");
  const pools = await loadBootstrapPools({
    rpcUrl: config.RPC_URL,
    multicall3Address: config.MULTICALL3_ADDRESS,
    pools: poolConfig,
    cuMeter,
  });
  rust.bootstrap(pools);
}

function scheduleBootstrap(delayMs = 0): void {
  if (bootstrapInFlight || bootstrapState.status === "ready" || bootstrapRetryTimer) {
    return;
  }

  if (delayMs <= 0) {
    void runBootstrap();
    return;
  }

  bootstrapState.nextRetryAt = Date.now() + delayMs;
  bootstrapRetryTimer = setTimeout(() => {
    bootstrapRetryTimer = undefined;
    void runBootstrap();
  }, delayMs);
  bootstrapRetryTimer.unref();
}

async function runBootstrap(): Promise<void> {
  if (bootstrapInFlight || bootstrapState.status === "ready") {
    return;
  }

  bootstrapInFlight = true;
  bootstrapState.status = "running";
  bootstrapState.attempts += 1;
  bootstrapState.lastAttemptAt = Date.now();
  bootstrapState.nextRetryAt = undefined;
  let retryMs: number | undefined;

  try {
    await bootstrap();
    bootstrapState.status = "ready";
    bootstrapState.lastSuccessAt = Date.now();
    bootstrapState.lastError = undefined;
    process.exitCode = undefined;
  } catch (error) {
    retryMs = Math.min(60_000, 2_000 * 2 ** Math.min(bootstrapState.attempts - 1, 5));
    bootstrapState.status = "failed";
    bootstrapState.lastError = error instanceof Error ? error.message : String(error);
    log.error({ error, retryMs }, "bootstrap failed; retrying");
  } finally {
    bootstrapInFlight = false;
    if (retryMs !== undefined) {
      scheduleBootstrap(retryMs);
    }
  }
}
