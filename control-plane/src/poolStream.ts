import { EventEmitter } from "node:events";
import { Contract, Interface, JsonRpcProvider, WebSocketProvider } from "ethers";
import { curveTwoCoinPoolAbi, multicall3Abi, uniswapV2PairAbi, uniswapV3PoolAbi } from "./abis.js";
import { expandV2Pools, filterStablePools } from "./discovery.js";
import type { AppConfig } from "./config.js";
import type { CuMeter } from "./cuMeter.js";
import { createLogger } from "./logger.js";
import type { PoolConfig, PoolUpdate, StablePoolConfig, V2PoolConfig, V3PoolConfig } from "./types.js";

interface OrientedPool {
  poolId: string;
  tokenIn: string;
}

interface PairSubscription {
  token0: string;
  orientations: OrientedPool[];
}

interface StableSubscription {
  poolId: string;
  poolAddress: string;
  handler: "curve_two_coin";
}

interface V3Subscription {
  poolId: string;
  poolAddress: string;
  handler: "uniswap_v3";
}

interface BatchCall {
  target: string;
  iface: Interface;
  fn: string;
  args: unknown[];
}

interface PairCursor {
  blockNumber: number;
  blockHash?: string;
  logIndex: number;
}

interface ReorgStatus {
  detectedTotal: number;
  recoveryTotal: number;
  lastDetectedAt?: number;
  lastRecoveredAt?: number;
  lastPair?: string;
  lastFromBlock?: number;
  lastToBlock?: number;
  lastReason?: string;
}

export class PoolStream extends EventEmitter {
  private readonly config: AppConfig;
  private readonly pools: PoolConfig[];
  private readonly cuMeter?: CuMeter;
  private readonly log = createLogger("pool-stream");
  private provider?: WebSocketProvider;
  private recoveryProvider?: JsonRpcProvider;
  private expandedV2Pools: V2PoolConfig[] = [];
  private stablePools: StablePoolConfig[] = [];
  private v3Pools: V3PoolConfig[] = [];
  private syncInterface = new Interface(uniswapV2PairAbi);
  private subscriptions = new Map<string, PairSubscription>();
  private stableSubscriptions: StableSubscription[] = [];
  private v3Subscriptions: V3Subscription[] = [];
  private lastSeenLog = new Map<string, PairCursor>();
  private blockHashesByPair = new Map<string, Map<number, string>>();
  private recoveringPairs = new Set<string>();
  private reorgingPairs = new Set<string>();
  private readonly reorgStatus: ReorgStatus = {
    detectedTotal: 0,
    recoveryTotal: 0,
  };
  private lastStableReserves = new Map<string, { reserveIn: string; reserveOut: string }>();
  private lastV3Reserves = new Map<string, { reserveIn: string; reserveOut: string }>();
  private reconnectTimer?: NodeJS.Timeout;
  private stablePollTimer?: NodeJS.Timeout;
  private v3PollTimer?: NodeJS.Timeout;
  private reconnecting = false;
  private closed = false;

  constructor(config: AppConfig, pools: PoolConfig[], cuMeter?: CuMeter) {
    super();
    this.config = config;
    this.pools = pools;
    this.cuMeter = cuMeter;
  }

  async connect(): Promise<void> {
    this.closed = false;
    if (!this.config.RPC_URL || !this.config.WS_RPC_URL) {
      this.log.info(
        { rpcConfigured: Boolean(this.config.RPC_URL), wsConfigured: Boolean(this.config.WS_RPC_URL) },
        "live pool stream disabled; missing RPC or websocket endpoint",
      );
      return;
    }

    this.recoveryProvider = new JsonRpcProvider(this.config.RPC_URL);
    this.expandedV2Pools = await expandV2Pools(this.recoveryProvider, this.config.MULTICALL3_ADDRESS, this.pools, this.cuMeter);
    this.stablePools = filterStablePools(this.pools);
    this.v3Pools = this.pools.filter((pool): pool is V3PoolConfig => pool.kind === "v3");

    await this.startProvider();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.provider) {
      this.provider.removeAllListeners();
      await this.provider.destroy();
      this.provider = undefined;
    }
    if (this.stablePollTimer) {
      clearInterval(this.stablePollTimer);
      this.stablePollTimer = undefined;
    }
    if (this.v3PollTimer) {
      clearInterval(this.v3PollTimer);
      this.v3PollTimer = undefined;
    }
    this.recoveryProvider = undefined;
  }

  status(): { reorg: ReorgStatus } {
    return {
      reorg: { ...this.reorgStatus },
    };
  }

  private async startProvider(): Promise<void> {
    if (!this.config.WS_RPC_URL) {
      return;
    }

    this.provider = new WebSocketProvider(this.config.WS_RPC_URL);
    this.attachProviderLifecycle(this.provider);
    await this.attachV2Listeners(this.expandedV2Pools);
    await this.attachStableHandlers(this.stablePools);
    await this.attachV3Handlers(this.v3Pools);
    await this.recoverAllPairs();
  }

  private attachProviderLifecycle(provider: WebSocketProvider): void {
    const rawSocket = (provider as unknown as { websocket?: { on?: Function } }).websocket;
    rawSocket?.on?.("close", () => {
      this.log.error("websocket provider closed; scheduling reconnect");
      void this.scheduleReconnect();
    });
    rawSocket?.on?.("error", (error: unknown) => {
      this.log.error({ error }, "websocket provider error; scheduling reconnect");
      void this.scheduleReconnect();
    });
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.closed || this.reconnecting) {
      return;
    }
    this.reconnecting = true;

    if (this.provider) {
      this.provider.removeAllListeners();
      await this.provider.destroy().catch(() => undefined);
      this.provider = undefined;
    }

    this.reconnectTimer = setTimeout(() => {
      void this.reconnect();
    }, 2_000);
  }

  private async reconnect(): Promise<void> {
    this.reconnectTimer = undefined;
    if (this.closed) {
      this.reconnecting = false;
      return;
    }

    try {
      this.log.info("reconnecting websocket pool stream");
      this.subscriptions.clear();
      this.stableSubscriptions = [];
      this.v3Subscriptions = [];
      await this.startProvider();
      this.log.info("websocket pool stream reconnected");
    } catch (error) {
      this.log.error({ error }, "websocket reconnect failed");
      this.reconnectTimer = setTimeout(() => {
        void this.reconnect();
      }, 5_000);
      return;
    }

    this.reconnecting = false;
  }

  private async attachV2Listeners(pools: V2PoolConfig[]): Promise<void> {
    if (!this.provider) {
      return;
    }

    const pairGroups = new Map<string, V2PoolConfig[]>();
    for (const pool of pools) {
      const key = pool.pair.toLowerCase();
      const existing = pairGroups.get(key) ?? [];
      existing.push(pool);
      pairGroups.set(key, existing);
    }

    const syncEvent = this.syncInterface.getEvent("Sync");
    if (!syncEvent) {
      throw new Error("Sync event missing from Uniswap V2 pair ABI");
    }
    const syncTopic = syncEvent.topicHash;

    for (const [pair, group] of pairGroups) {
      const contract = new Contract(pair, uniswapV2PairAbi, this.provider);
      const token0 = String(await contract.token0()).toLowerCase();
      this.cuMeter?.recordMethod("eth_call");
      this.subscriptions.set(pair, {
        token0,
        orientations: group.map((pool) => ({
          poolId: pool.poolId,
          tokenIn: pool.tokenIn.toLowerCase(),
        })),
      });

      this.provider.on({ address: pair, topics: [syncTopic] }, (log) => {
        this.cuMeter?.recordWebSocketPayload(log);
        if (isRemovedLog(log)) {
          void this.handleReorg(pair, log.blockNumber, "removed log from websocket provider");
          return;
        }
        const decoded = this.syncInterface.decodeEventLog("Sync", log.data, log.topics);
        const reserve0 = BigInt(String(decoded.reserve0));
        const reserve1 = BigInt(String(decoded.reserve1));
        this.handleSync(pair, reserve0, reserve1, log.blockNumber, Number(log.index), log.blockHash);
      });
      this.cuMeter?.recordMethod("eth_subscribe");
    }

    this.log.info({ subscriptions: pairGroups.size }, "attached live v2 sync listeners");
  }

  private async attachStableHandlers(pools: StablePoolConfig[]): Promise<void> {
    if (!this.provider || !this.recoveryProvider) {
      return;
    }

    this.stableSubscriptions = pools
      .filter((pool): pool is StablePoolConfig & { poolAddress: string; handler: "curve_two_coin" } =>
        Boolean(pool.poolAddress) && pool.handler === "curve_two_coin",
      )
      .map((pool) => ({
        poolId: pool.poolId,
        poolAddress: pool.poolAddress,
        handler: "curve_two_coin" as const,
      }));

    if (this.stableSubscriptions.length === 0) {
      return;
    }

    const blockNumber = await this.recoveryProvider.getBlockNumber();
    this.cuMeter?.recordMethod("eth_blockNumber");
    await this.pollStablePoolsBatched(blockNumber, this.reconnecting ? "reconnect_recovery" : "recovery");
    if (this.config.STABLE_POLL_INTERVAL_MS > 0) {
      this.stablePollTimer = setInterval(() => {
        void this.pollStablePoolsFromHead(this.reconnecting ? "reconnect_recovery" : "live");
      }, this.config.STABLE_POLL_INTERVAL_MS);
      this.log.info(
        { stableSubscriptions: this.stableSubscriptions.length, intervalMs: this.config.STABLE_POLL_INTERVAL_MS },
        "attached stable pool polling handlers",
      );
      return;
    }

    this.log.info({ stableSubscriptions: this.stableSubscriptions.length }, "stable pool polling disabled after recovery snapshot");
  }

  private async attachV3Handlers(pools: V3PoolConfig[]): Promise<void> {
    if (!this.provider || !this.recoveryProvider) {
      return;
    }

    this.v3Subscriptions = pools
      .filter((pool): pool is V3PoolConfig & { poolAddress: string } => Boolean(pool.poolAddress))
      .map((pool) => ({
        poolId: pool.poolId,
        poolAddress: pool.poolAddress,
        handler: "uniswap_v3" as const,
      }));

    if (this.v3Subscriptions.length === 0) {
      return;
    }

    const blockNumber = await this.recoveryProvider.getBlockNumber();
    this.cuMeter?.recordMethod("eth_blockNumber");
    await this.pollV3Pools(blockNumber, this.reconnecting ? "reconnect_recovery" : "recovery");
    if (this.config.V3_POLL_INTERVAL_MS > 0) {
      this.v3PollTimer = setInterval(() => {
        void this.pollV3PoolsFromHead(this.reconnecting ? "reconnect_recovery" : "live");
      }, this.config.V3_POLL_INTERVAL_MS);
      this.log.info(
        { v3Subscriptions: this.v3Subscriptions.length, intervalMs: this.config.V3_POLL_INTERVAL_MS },
        "attached v3 pool polling handlers",
      );
      return;
    }

    this.log.info({ v3Subscriptions: this.v3Subscriptions.length }, "v3 pool polling disabled after recovery snapshot");
  }

  private handleSync(pair: string, reserve0: bigint, reserve1: bigint, blockNumber: number, logIndex: number, blockHash?: string): void {
    const pairKey = pair.toLowerCase();
    const subscription = this.subscriptions.get(pairKey);
    if (!subscription) {
      return;
    }

    const cursor = this.lastSeenLog.get(pairKey);
    const previousBlock = cursor?.blockNumber;
    if (this.detectReorg(pairKey, blockNumber, logIndex, blockHash, cursor)) {
      void this.handleReorg(pair, blockNumber, "canonical block hash changed or live log moved behind cursor");
      return;
    }
    if (previousBlock !== undefined && blockNumber - previousBlock > this.config.STREAM_MAX_BLOCK_GAP) {
      this.log.error(
        { pair, previousBlock, blockNumber, gap: blockNumber - previousBlock },
        "detected block gap in live stream; starting block replay",
      );
      void this.replayPair(pair, previousBlock + 1, blockNumber);
    }
    this.recordCursor(pairKey, blockNumber, logIndex, blockHash);

    for (const oriented of subscription.orientations) {
      const tokenInIsToken0 = oriented.tokenIn === subscription.token0;
      const update: PoolUpdate = {
        pool_id: oriented.poolId,
        reserve_in: (tokenInIsToken0 ? reserve0 : reserve1).toString(),
        reserve_out: (tokenInIsToken0 ? reserve1 : reserve0).toString(),
        block_number: blockNumber,
        log_index: logIndex,
        source: "live",
      };
      this.emit("pool_update", update);
    }
  }

  private async recoverPair(pair: string): Promise<void> {
    const pairKey = pair.toLowerCase();
    if (this.recoveringPairs.has(pairKey)) {
      return;
    }
    this.recoveringPairs.add(pairKey);
    try {
      await this.recoverPairSnapshot(pair);
    } finally {
      this.recoveringPairs.delete(pairKey);
    }
  }

  private async recoverPairSnapshot(pair: string): Promise<void> {
    const pairKey = pair.toLowerCase();
    if (!this.recoveryProvider) {
      this.log.error({ pair }, "cannot recover pair without RPC provider");
      return;
    }

    const subscription = this.subscriptions.get(pairKey);
    if (!subscription) {
      return;
    }

    try {
      const contract = new Contract(pair, uniswapV2PairAbi, this.recoveryProvider);
      const [reserves, blockNumber] = await Promise.all([contract.getReserves(), this.recoveryProvider.getBlockNumber()]);
      this.cuMeter?.recordMethod("eth_call");
      this.cuMeter?.recordMethod("eth_blockNumber");
      const reserve0 = BigInt(String(reserves.reserve0));
      const reserve1 = BigInt(String(reserves.reserve1));

      const previousBlock = this.lastSeenLog.get(pairKey)?.blockNumber;
      this.recordCursor(pairKey, blockNumber, Number.MAX_SAFE_INTEGER);
      for (const oriented of subscription.orientations) {
        const tokenInIsToken0 = oriented.tokenIn === subscription.token0;
        const update: PoolUpdate = {
          pool_id: oriented.poolId,
          reserve_in: (tokenInIsToken0 ? reserve0 : reserve1).toString(),
          reserve_out: (tokenInIsToken0 ? reserve1 : reserve0).toString(),
          block_number: blockNumber,
          log_index: Number.MAX_SAFE_INTEGER,
          source: this.reconnecting ? "reconnect_recovery" : "recovery",
          replay_from_block: previousBlock !== undefined ? previousBlock + 1 : blockNumber,
          replay_to_block: blockNumber,
        };
        this.emit("pool_update", update);
      }

      this.log.info({ pair, blockNumber }, "recovered pair reserves after stream gap");
    } catch (error) {
      this.log.error({ pair, error }, "pair recovery failed");
    }
  }

  private async replayPair(pair: string, fromBlock: number, toBlock: number): Promise<void> {
    const pairKey = pair.toLowerCase();
    if (this.recoveringPairs.has(pairKey)) {
      return;
    }
    if (!this.recoveryProvider) {
      this.log.error({ pair, fromBlock, toBlock }, "cannot replay pair without RPC provider");
      return;
    }

    const subscription = this.subscriptions.get(pairKey);
    const syncEvent = this.syncInterface.getEvent("Sync");
    if (!subscription || !syncEvent) {
      return;
    }

    this.recoveringPairs.add(pairKey);
    try {
      const logs = await this.recoveryProvider.getLogs({
        address: pair,
        topics: [syncEvent.topicHash],
        fromBlock,
        toBlock,
      });
      this.cuMeter?.recordMethod("eth_getLogs");

      if (logs.length === 0) {
        await this.recoverPair(pair);
        return;
      }

      logs.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) {
          return a.blockNumber - b.blockNumber;
        }
        return Number(a.index) - Number(b.index);
      });

      for (const log of logs) {
        if (isRemovedLog(log)) {
          continue;
        }
        const decoded = this.syncInterface.decodeEventLog("Sync", log.data, log.topics);
        const reserve0 = BigInt(String(decoded.reserve0));
        const reserve1 = BigInt(String(decoded.reserve1));
        this.emitReplayUpdate(subscription, reserve0, reserve1, log.blockNumber, Number(log.index), log.blockHash, fromBlock, toBlock);
        this.recordCursor(pairKey, log.blockNumber, Number(log.index), log.blockHash);
      }

      this.log.info({ pair, fromBlock, toBlock, replayedLogs: logs.length }, "replayed pair sync logs across missed block range");
    } catch (error) {
      this.log.error({ pair, fromBlock, toBlock, error }, "pair replay failed; falling back to reserve recovery");
      await this.recoverPairSnapshot(pair);
    } finally {
      this.recoveringPairs.delete(pairKey);
    }
  }

  private emitReplayUpdate(
    subscription: PairSubscription,
    reserve0: bigint,
    reserve1: bigint,
    blockNumber: number,
    logIndex: number,
    blockHash: string | undefined,
    fromBlock: number,
    toBlock: number,
  ): void {
    void blockHash;
    for (const oriented of subscription.orientations) {
      const tokenInIsToken0 = oriented.tokenIn === subscription.token0;
      const update: PoolUpdate = {
        pool_id: oriented.poolId,
        reserve_in: (tokenInIsToken0 ? reserve0 : reserve1).toString(),
        reserve_out: (tokenInIsToken0 ? reserve1 : reserve0).toString(),
        block_number: blockNumber,
        log_index: logIndex,
        source: this.reconnecting ? "reconnect_recovery" : "recovery",
        replay_from_block: fromBlock,
        replay_to_block: toBlock,
      };
      this.emit("pool_update", update);
    }
  }

  private async recoverAllPairs(): Promise<void> {
    await Promise.all([...this.subscriptions.keys()].map((pair) => this.recoverPair(pair)));
  }

  private detectReorg(
    pairKey: string,
    blockNumber: number,
    logIndex: number,
    blockHash: string | undefined,
    cursor: PairCursor | undefined,
  ): boolean {
    if (!cursor) {
      return false;
    }

    const knownBlockHash = blockHash ? this.blockHashesByPair.get(pairKey)?.get(blockNumber) : undefined;
    if (knownBlockHash && knownBlockHash !== blockHash) {
      return true;
    }

    if (blockNumber < cursor.blockNumber) {
      return true;
    }

    if (blockNumber === cursor.blockNumber && logIndex <= cursor.logIndex) {
      return Boolean(blockHash && cursor.blockHash && blockHash !== cursor.blockHash);
    }

    return false;
  }

  private recordCursor(pairKey: string, blockNumber: number, logIndex: number, blockHash?: string): void {
    this.lastSeenLog.set(pairKey, { blockNumber, blockHash, logIndex });
    if (!blockHash) {
      return;
    }

    const hashes = this.blockHashesByPair.get(pairKey) ?? new Map<number, string>();
    hashes.set(blockNumber, blockHash);
    const keepFromBlock = blockNumber - Math.max(this.config.STREAM_REORG_LOOKBACK_BLOCKS * 2, 24);
    for (const knownBlock of hashes.keys()) {
      if (knownBlock < keepFromBlock) {
        hashes.delete(knownBlock);
      }
    }
    this.blockHashesByPair.set(pairKey, hashes);
  }

  private async handleReorg(pair: string, observedBlock: number, reason: string): Promise<void> {
    const pairKey = pair.toLowerCase();
    if (this.reorgingPairs.has(pairKey)) {
      return;
    }

    this.reorgingPairs.add(pairKey);
    this.reorgStatus.detectedTotal += 1;
    this.reorgStatus.lastDetectedAt = Date.now();
    this.reorgStatus.lastPair = pair;
    this.reorgStatus.lastReason = reason;
    this.emit("reorg", {
      pair,
      observedBlock,
      reason,
      detectedAt: this.reorgStatus.lastDetectedAt,
    });

    try {
      const cursor = this.lastSeenLog.get(pairKey);
      const anchorBlock = Math.min(observedBlock, cursor?.blockNumber ?? observedBlock);
      const fromBlock = Math.max(0, anchorBlock - this.config.STREAM_REORG_LOOKBACK_BLOCKS);
      const head = this.recoveryProvider ? await this.recoveryProvider.getBlockNumber() : observedBlock;
      this.cuMeter?.recordMethod("eth_blockNumber");
      this.reorgStatus.lastFromBlock = fromBlock;
      this.reorgStatus.lastToBlock = head;

      this.log.error({ pair, observedBlock, fromBlock, head, reason }, "detected pool stream reorg; recovering canonical reserves");
      this.lastSeenLog.delete(pairKey);
      this.blockHashesByPair.delete(pairKey);
      await this.replayPair(pair, fromBlock, head);
      await this.recoverPairSnapshotWithSource(pair, "reorg_recovery", fromBlock, head);
      this.reorgStatus.recoveryTotal += 1;
      this.reorgStatus.lastRecoveredAt = Date.now();
    } catch (error) {
      this.log.error({ pair, observedBlock, reason, error }, "pool stream reorg recovery failed");
    } finally {
      this.reorgingPairs.delete(pairKey);
    }
  }

  private async recoverPairSnapshotWithSource(
    pair: string,
    source: NonNullable<PoolUpdate["source"]>,
    replayFromBlock?: number,
    replayToBlock?: number,
  ): Promise<void> {
    const pairKey = pair.toLowerCase();
    if (!this.recoveryProvider) {
      this.log.error({ pair }, "cannot recover pair without RPC provider");
      return;
    }

    const subscription = this.subscriptions.get(pairKey);
    if (!subscription) {
      return;
    }

    try {
      const contract = new Contract(pair, uniswapV2PairAbi, this.recoveryProvider);
      const [reserves, blockNumber] = await Promise.all([contract.getReserves(), this.recoveryProvider.getBlockNumber()]);
      this.cuMeter?.recordMethod("eth_call");
      this.cuMeter?.recordMethod("eth_blockNumber");
      const reserve0 = BigInt(String(reserves.reserve0));
      const reserve1 = BigInt(String(reserves.reserve1));

      this.recordCursor(pairKey, blockNumber, Number.MAX_SAFE_INTEGER);
      for (const oriented of subscription.orientations) {
        const tokenInIsToken0 = oriented.tokenIn === subscription.token0;
        const update: PoolUpdate = {
          pool_id: oriented.poolId,
          reserve_in: (tokenInIsToken0 ? reserve0 : reserve1).toString(),
          reserve_out: (tokenInIsToken0 ? reserve1 : reserve0).toString(),
          block_number: blockNumber,
          log_index: Number.MAX_SAFE_INTEGER,
          source,
          replay_from_block: replayFromBlock,
          replay_to_block: replayToBlock ?? blockNumber,
        };
        this.emit("pool_update", update);
      }
    } catch (error) {
      this.log.error({ pair, error }, "pair reserve recovery failed");
    }
  }

  private async pollStablePools(
    blockNumber: number,
    source: NonNullable<PoolUpdate["source"]>,
  ): Promise<void> {
    if (!this.recoveryProvider) {
      return;
    }

    await Promise.all(
      this.stableSubscriptions.map(async (subscription) => {
        try {
          const contract = new Contract(subscription.poolAddress, curveTwoCoinPoolAbi, this.recoveryProvider);
          const [reserveIn, reserveOut] = await Promise.all([contract.balances(0), contract.balances(1)]);
          const next = {
            reserveIn: reserveIn.toString(),
            reserveOut: reserveOut.toString(),
          };
          const previous = this.lastStableReserves.get(subscription.poolId);
          if (previous && previous.reserveIn === next.reserveIn && previous.reserveOut === next.reserveOut) {
            return;
          }
          this.lastStableReserves.set(subscription.poolId, next);

          const update: PoolUpdate = {
            pool_id: subscription.poolId,
            reserve_in: next.reserveIn,
          reserve_out: next.reserveOut,
          block_number: blockNumber,
          log_index: Number.MAX_SAFE_INTEGER,
          sqrt_price_x96: undefined,
          liquidity: undefined,
          source,
        };
          this.emit("pool_update", update);
        } catch (error) {
          this.log.error({ poolId: subscription.poolId, error }, "stable pool polling failed");
        }
      }),
    );
  }

  private async pollStablePoolsBatched(
    blockNumber: number,
    source: NonNullable<PoolUpdate["source"]>,
  ): Promise<void> {
    if (!this.recoveryProvider || this.stableSubscriptions.length === 0) {
      return;
    }

    const curveInterface = new Interface(curveTwoCoinPoolAbi);
    const calls: BatchCall[] = this.stableSubscriptions.flatMap((subscription) => [
      { target: subscription.poolAddress, iface: curveInterface, fn: "balances", args: [0] },
      { target: subscription.poolAddress, iface: curveInterface, fn: "balances", args: [1] },
    ]);

    const results = await this.batchRead(calls);
    this.stableSubscriptions.forEach((subscription, index) => {
      const reserveIn = BigInt(String(results[index * 2]?.[0] ?? 0));
      const reserveOut = BigInt(String(results[index * 2 + 1]?.[0] ?? 0));
      this.emitStableUpdate(subscription, reserveIn, reserveOut, blockNumber, source);
    });
  }

  private emitStableUpdate(
    subscription: StableSubscription,
    reserveIn: bigint,
    reserveOut: bigint,
    blockNumber: number,
    source: NonNullable<PoolUpdate["source"]>,
  ): void {
    const next = {
      reserveIn: reserveIn.toString(),
      reserveOut: reserveOut.toString(),
    };
    const previous = this.lastStableReserves.get(subscription.poolId);
    if (previous && previous.reserveIn === next.reserveIn && previous.reserveOut === next.reserveOut) {
      return;
    }
    this.lastStableReserves.set(subscription.poolId, next);

    const update: PoolUpdate = {
      pool_id: subscription.poolId,
      reserve_in: next.reserveIn,
      reserve_out: next.reserveOut,
      block_number: blockNumber,
      log_index: Number.MAX_SAFE_INTEGER,
      sqrt_price_x96: undefined,
      liquidity: undefined,
      source,
    };
    this.emit("pool_update", update);
  }

  private async pollStablePoolsFromHead(source: NonNullable<PoolUpdate["source"]>): Promise<void> {
    if (!this.recoveryProvider) {
      return;
    }

    const blockNumber = await this.recoveryProvider.getBlockNumber();
    this.cuMeter?.recordMethod("eth_blockNumber");
    await this.pollStablePoolsBatched(blockNumber, source);
  }

  private async pollV3Pools(
    blockNumber: number,
    source: NonNullable<PoolUpdate["source"]>,
  ): Promise<void> {
    if (!this.recoveryProvider) {
      return;
    }

    const v3Interface = new Interface(uniswapV3PoolAbi);
    const calls: BatchCall[] = this.v3Subscriptions.flatMap((subscription) => [
      { target: subscription.poolAddress, iface: v3Interface, fn: "slot0", args: [] },
      { target: subscription.poolAddress, iface: v3Interface, fn: "liquidity", args: [] },
    ]);

    const results = await this.batchRead(calls);
    this.v3Subscriptions.forEach((subscription, index) => {
      const slot0 = results[index * 2];
      const liquidityResult = results[index * 2 + 1];
      const sqrtPriceX96 = BigInt(String(slot0?.[0] ?? 0));
      const currentLiquidity = BigInt(String(liquidityResult?.[0] ?? 0));
      const [reserveIn, reserveOut] = estimateV3Reserves(sqrtPriceX96, currentLiquidity);
      const next = {
        reserveIn: reserveIn.toString(),
        reserveOut: reserveOut.toString(),
      };
      const previous = this.lastV3Reserves.get(subscription.poolId);
      if (previous && previous.reserveIn === next.reserveIn && previous.reserveOut === next.reserveOut) {
        return;
      }
      this.lastV3Reserves.set(subscription.poolId, next);

      const update: PoolUpdate = {
        pool_id: subscription.poolId,
        reserve_in: next.reserveIn,
        reserve_out: next.reserveOut,
        block_number: blockNumber,
        log_index: Number.MAX_SAFE_INTEGER,
        sqrt_price_x96: sqrtPriceX96.toString(),
        liquidity: currentLiquidity.toString(),
        source,
      };
      this.emit("pool_update", update);
    });
  }

  private async pollV3PoolsFromHead(source: NonNullable<PoolUpdate["source"]>): Promise<void> {
    if (!this.recoveryProvider) {
      return;
    }

    const blockNumber = await this.recoveryProvider.getBlockNumber();
    this.cuMeter?.recordMethod("eth_blockNumber");
    await this.pollV3Pools(blockNumber, source);
  }

  private async batchRead(calls: BatchCall[]): Promise<unknown[][]> {
    if (!this.recoveryProvider || calls.length === 0) {
      return [];
    }

    if (!this.config.MULTICALL3_ADDRESS) {
      this.cuMeter?.recordMethod("eth_call", calls.length);
      return Promise.all(
        calls.map(async (call) => {
          const encoded = call.iface.encodeFunctionData(call.fn, call.args);
          const response = await this.recoveryProvider!.call({ to: call.target, data: encoded });
          return call.iface.decodeFunctionResult(call.fn, response).toArray();
        }),
      );
    }

    const multicall = new Contract(this.config.MULTICALL3_ADDRESS, multicall3Abi, this.recoveryProvider);
    this.cuMeter?.recordMethod("eth_call");
    const aggregateCalls = calls.map((call) => ({
      target: call.target,
      allowFailure: true,
      callData: call.iface.encodeFunctionData(call.fn, call.args),
    }));
    const responses = (await multicall.aggregate3.staticCall(aggregateCalls)) as Array<{
      success: boolean;
      returnData: string;
    }>;

    return responses.map((response, index) => {
      if (!response.success) {
        this.log.error({ target: calls[index]?.target, fn: calls[index]?.fn }, "multicall stream read failed");
        return [];
      }
      return calls[index].iface.decodeFunctionResult(calls[index].fn, response.returnData).toArray();
    });
  }
}

function estimateV3Reserves(sqrtPriceX96: bigint, liquidity: bigint): [bigint, bigint] {
  if (sqrtPriceX96 === 0n || liquidity === 0n) {
    return [0n, 0n];
  }
  const q96 = 2n ** 96n;
  const reserveIn = liquidity * q96 / sqrtPriceX96;
  const reserveOut = liquidity * sqrtPriceX96 / q96;
  return [reserveIn, reserveOut];
}

function isRemovedLog(log: unknown): boolean {
  return Boolean((log as { removed?: boolean }).removed);
}
