import { JsonRpcProvider } from "ethers";
import type { AppConfig } from "./config.js";
import type { CuMeter } from "./cuMeter.js";
import { createLogger } from "./logger.js";

interface RpcProbeStatus {
  name: string;
  enabled: boolean;
  healthy: boolean;
  url?: string;
  lastLatencyMs?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  consecutiveFailures: number;
  lastError?: string;
  latestBlock?: number;
}

export interface RpcMonitorStatus {
  publicRpc: RpcProbeStatus;
  relayRpc: RpcProbeStatus;
}

export class RpcMonitor {
  private readonly log = createLogger("rpc-monitor");
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly publicProvider?: JsonRpcProvider;
  private readonly relayProvider?: JsonRpcProvider;
  private readonly cuMeter?: CuMeter;
  private readonly status: RpcMonitorStatus;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(config: AppConfig, cuMeter?: CuMeter) {
    this.intervalMs = config.RPC_MONITOR_INTERVAL_MS;
    this.timeoutMs = config.RPC_MONITOR_TIMEOUT_MS;
    this.cuMeter = cuMeter;
    this.publicProvider = config.RPC_URL ? new JsonRpcProvider(config.RPC_URL) : undefined;
    this.relayProvider = config.PRIVATE_RELAY_RPC_URL ? new JsonRpcProvider(config.PRIVATE_RELAY_RPC_URL) : undefined;
    this.status = {
      publicRpc: {
        name: "public",
        enabled: Boolean(config.RPC_URL),
        healthy: false,
        url: config.RPC_URL,
        consecutiveFailures: 0,
      },
      relayRpc: {
        name: "relay",
        enabled: Boolean(config.PRIVATE_RELAY_RPC_URL),
        healthy: false,
        url: config.PRIVATE_RELAY_RPC_URL,
        consecutiveFailures: 0,
      },
    };
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.pollAll();
    this.timer = setInterval(() => {
      void this.pollAll();
    }, this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  snapshot(): RpcMonitorStatus {
    return {
      publicRpc: this.safeProbeSnapshot(this.status.publicRpc),
      relayRpc: this.safeProbeSnapshot(this.status.relayRpc),
    };
  }

  private safeProbeSnapshot(probe: RpcProbeStatus): RpcProbeStatus {
    const { url: _url, ...safeProbe } = probe;
    return safeProbe;
  }

  private async pollAll(): Promise<void> {
    await Promise.all([
      this.probe("publicRpc", this.publicProvider),
      this.probe("relayRpc", this.relayProvider),
    ]);
  }

  private async probe(key: keyof RpcMonitorStatus, provider?: JsonRpcProvider): Promise<void> {
    const probe = this.status[key];
    if (!probe.enabled || !provider) {
      return;
    }

    const startedAt = Date.now();
    try {
      const latestBlock = await Promise.race([
        provider.getBlockNumber(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`RPC timeout after ${this.timeoutMs}ms`)), this.timeoutMs),
        ),
      ]);

      this.cuMeter?.recordMethod("eth_blockNumber");
      probe.healthy = true;
      probe.lastLatencyMs = Date.now() - startedAt;
      probe.lastSuccessAt = Date.now();
      probe.latestBlock = latestBlock;
      probe.consecutiveFailures = 0;
      probe.lastError = undefined;
    } catch (error) {
      probe.healthy = false;
      probe.lastFailureAt = Date.now();
      probe.consecutiveFailures += 1;
      probe.lastError = error instanceof Error ? error.message : String(error);
      this.log.error({ rpc: probe.name, error }, "rpc latency probe failed");
    }
  }
}
