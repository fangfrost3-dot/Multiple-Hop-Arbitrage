import { EventEmitter } from "node:events";
import { Contract, Interface, JsonRpcProvider, WebSocketProvider } from "ethers";
import { curveTwoCoinPoolAbi, uniswapV2PairAbi, uniswapV3PoolAbi } from "./abis.js";
import { expandV2Pools, filterStablePools } from "./discovery.js";
import { createLogger } from "./logger.js";
export class PoolStream extends EventEmitter {
    config;
    pools;
    log = createLogger("pool-stream");
    provider;
    recoveryProvider;
    expandedV2Pools = [];
    stablePools = [];
    v3Pools = [];
    syncInterface = new Interface(uniswapV2PairAbi);
    subscriptions = new Map();
    stableSubscriptions = [];
    v3Subscriptions = [];
    lastSeenBlock = new Map();
    recoveringPairs = new Set();
    lastStableReserves = new Map();
    lastV3Reserves = new Map();
    reconnectTimer;
    reconnecting = false;
    closed = false;
    constructor(config, pools) {
        super();
        this.config = config;
        this.pools = pools;
    }
    async connect() {
        this.closed = false;
        if (!this.config.RPC_URL || !this.config.WS_RPC_URL) {
            this.log.info({ rpcConfigured: Boolean(this.config.RPC_URL), wsConfigured: Boolean(this.config.WS_RPC_URL) }, "live pool stream disabled; missing RPC or websocket endpoint");
            return;
        }
        this.recoveryProvider = new JsonRpcProvider(this.config.RPC_URL);
        this.expandedV2Pools = await expandV2Pools(this.recoveryProvider, this.config.MULTICALL3_ADDRESS, this.pools);
        this.stablePools = filterStablePools(this.pools);
        this.v3Pools = this.pools.filter((pool) => pool.kind === "v3");
        await this.startProvider();
    }
    async close() {
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
        this.recoveryProvider = undefined;
    }
    async startProvider() {
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
    attachProviderLifecycle(provider) {
        const rawSocket = provider.websocket;
        rawSocket?.on?.("close", () => {
            this.log.error("websocket provider closed; scheduling reconnect");
            void this.scheduleReconnect();
        });
        rawSocket?.on?.("error", (error) => {
            this.log.error({ error }, "websocket provider error; scheduling reconnect");
            void this.scheduleReconnect();
        });
    }
    async scheduleReconnect() {
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
    async reconnect() {
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
        }
        catch (error) {
            this.log.error({ error }, "websocket reconnect failed");
            this.reconnectTimer = setTimeout(() => {
                void this.reconnect();
            }, 5_000);
            return;
        }
        this.reconnecting = false;
    }
    async attachV2Listeners(pools) {
        if (!this.provider) {
            return;
        }
        const pairGroups = new Map();
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
            this.subscriptions.set(pair, {
                token0,
                orientations: group.map((pool) => ({
                    poolId: pool.poolId,
                    tokenIn: pool.tokenIn.toLowerCase(),
                })),
            });
            this.provider.on({ address: pair, topics: [syncTopic] }, (log) => {
                const decoded = this.syncInterface.decodeEventLog("Sync", log.data, log.topics);
                const reserve0 = BigInt(String(decoded.reserve0));
                const reserve1 = BigInt(String(decoded.reserve1));
                this.handleSync(pair, reserve0, reserve1, log.blockNumber);
            });
        }
        this.log.info({ subscriptions: pairGroups.size }, "attached live v2 sync listeners");
    }
    async attachStableHandlers(pools) {
        if (!this.provider || !this.recoveryProvider) {
            return;
        }
        this.stableSubscriptions = pools
            .filter((pool) => Boolean(pool.poolAddress) && pool.handler === "curve_two_coin")
            .map((pool) => ({
            poolId: pool.poolId,
            poolAddress: pool.poolAddress,
            handler: "curve_two_coin",
        }));
        if (this.stableSubscriptions.length === 0) {
            return;
        }
        this.provider.on("block", (blockNumber) => {
            void this.pollStablePools(blockNumber, this.reconnecting ? "reconnect_recovery" : "live");
        });
        await this.pollStablePools(await this.recoveryProvider.getBlockNumber(), this.reconnecting ? "reconnect_recovery" : "recovery");
        this.log.info({ stableSubscriptions: this.stableSubscriptions.length }, "attached stable pool live handlers");
    }
    async attachV3Handlers(pools) {
        if (!this.provider || !this.recoveryProvider) {
            return;
        }
        this.v3Subscriptions = pools
            .filter((pool) => Boolean(pool.poolAddress))
            .map((pool) => ({
            poolId: pool.poolId,
            poolAddress: pool.poolAddress,
            handler: "uniswap_v3",
        }));
        if (this.v3Subscriptions.length === 0) {
            return;
        }
        this.provider.on("block", (blockNumber) => {
            void this.pollV3Pools(blockNumber, this.reconnecting ? "reconnect_recovery" : "live");
        });
        await this.pollV3Pools(await this.recoveryProvider.getBlockNumber(), this.reconnecting ? "reconnect_recovery" : "recovery");
        this.log.info({ v3Subscriptions: this.v3Subscriptions.length }, "attached v3 pool live handlers");
    }
    handleSync(pair, reserve0, reserve1, blockNumber) {
        const subscription = this.subscriptions.get(pair.toLowerCase());
        if (!subscription) {
            return;
        }
        const previousBlock = this.lastSeenBlock.get(pair.toLowerCase());
        if (previousBlock !== undefined && blockNumber - previousBlock > this.config.STREAM_MAX_BLOCK_GAP) {
            this.log.error({ pair, previousBlock, blockNumber, gap: blockNumber - previousBlock }, "detected block gap in live stream; starting block replay");
            void this.replayPair(pair, previousBlock + 1, blockNumber);
        }
        this.lastSeenBlock.set(pair.toLowerCase(), blockNumber);
        for (const oriented of subscription.orientations) {
            const tokenInIsToken0 = oriented.tokenIn === subscription.token0;
            const update = {
                pool_id: oriented.poolId,
                reserve_in: (tokenInIsToken0 ? reserve0 : reserve1).toString(),
                reserve_out: (tokenInIsToken0 ? reserve1 : reserve0).toString(),
                block_number: blockNumber,
                source: "live",
            };
            this.emit("pool_update", update);
        }
    }
    async recoverPair(pair) {
        const pairKey = pair.toLowerCase();
        if (this.recoveringPairs.has(pairKey)) {
            return;
        }
        this.recoveringPairs.add(pairKey);
        try {
            await this.recoverPairSnapshot(pair);
        }
        finally {
            this.recoveringPairs.delete(pairKey);
        }
    }
    async recoverPairSnapshot(pair) {
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
            const reserve0 = BigInt(String(reserves.reserve0));
            const reserve1 = BigInt(String(reserves.reserve1));
            const previousBlock = this.lastSeenBlock.get(pairKey);
            this.lastSeenBlock.set(pairKey, blockNumber);
            for (const oriented of subscription.orientations) {
                const tokenInIsToken0 = oriented.tokenIn === subscription.token0;
                const update = {
                    pool_id: oriented.poolId,
                    reserve_in: (tokenInIsToken0 ? reserve0 : reserve1).toString(),
                    reserve_out: (tokenInIsToken0 ? reserve1 : reserve0).toString(),
                    block_number: blockNumber,
                    source: this.reconnecting ? "reconnect_recovery" : "recovery",
                    replay_from_block: previousBlock !== undefined ? previousBlock + 1 : blockNumber,
                    replay_to_block: blockNumber,
                };
                this.emit("pool_update", update);
            }
            this.log.info({ pair, blockNumber }, "recovered pair reserves after stream gap");
        }
        catch (error) {
            this.log.error({ pair, error }, "pair recovery failed");
        }
    }
    async replayPair(pair, fromBlock, toBlock) {
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
                const decoded = this.syncInterface.decodeEventLog("Sync", log.data, log.topics);
                const reserve0 = BigInt(String(decoded.reserve0));
                const reserve1 = BigInt(String(decoded.reserve1));
                this.emitReplayUpdate(subscription, reserve0, reserve1, log.blockNumber, fromBlock, toBlock);
                this.lastSeenBlock.set(pairKey, log.blockNumber);
            }
            this.log.info({ pair, fromBlock, toBlock, replayedLogs: logs.length }, "replayed pair sync logs across missed block range");
        }
        catch (error) {
            this.log.error({ pair, fromBlock, toBlock, error }, "pair replay failed; falling back to reserve recovery");
            await this.recoverPairSnapshot(pair);
        }
        finally {
            this.recoveringPairs.delete(pairKey);
        }
    }
    emitReplayUpdate(subscription, reserve0, reserve1, blockNumber, fromBlock, toBlock) {
        for (const oriented of subscription.orientations) {
            const tokenInIsToken0 = oriented.tokenIn === subscription.token0;
            const update = {
                pool_id: oriented.poolId,
                reserve_in: (tokenInIsToken0 ? reserve0 : reserve1).toString(),
                reserve_out: (tokenInIsToken0 ? reserve1 : reserve0).toString(),
                block_number: blockNumber,
                source: this.reconnecting ? "reconnect_recovery" : "recovery",
                replay_from_block: fromBlock,
                replay_to_block: toBlock,
            };
            this.emit("pool_update", update);
        }
    }
    async recoverAllPairs() {
        await Promise.all([...this.subscriptions.keys()].map((pair) => this.recoverPair(pair)));
    }
    async pollStablePools(blockNumber, source) {
        if (!this.recoveryProvider) {
            return;
        }
        await Promise.all(this.stableSubscriptions.map(async (subscription) => {
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
                const update = {
                    pool_id: subscription.poolId,
                    reserve_in: next.reserveIn,
                    reserve_out: next.reserveOut,
                    block_number: blockNumber,
                    source,
                };
                this.emit("pool_update", update);
            }
            catch (error) {
                this.log.error({ poolId: subscription.poolId, error }, "stable pool polling failed");
            }
        }));
    }
    async pollV3Pools(blockNumber, source) {
        if (!this.recoveryProvider) {
            return;
        }
        await Promise.all(this.v3Subscriptions.map(async (subscription) => {
            try {
                const contract = new Contract(subscription.poolAddress, uniswapV3PoolAbi, this.recoveryProvider);
                const [slot0, liquidity] = await Promise.all([contract.slot0(), contract.liquidity()]);
                const [reserveIn, reserveOut] = estimateV3Reserves(BigInt(slot0.sqrtPriceX96), BigInt(liquidity));
                const next = {
                    reserveIn: reserveIn.toString(),
                    reserveOut: reserveOut.toString(),
                };
                const previous = this.lastV3Reserves.get(subscription.poolId);
                if (previous && previous.reserveIn === next.reserveIn && previous.reserveOut === next.reserveOut) {
                    return;
                }
                this.lastV3Reserves.set(subscription.poolId, next);
                const update = {
                    pool_id: subscription.poolId,
                    reserve_in: next.reserveIn,
                    reserve_out: next.reserveOut,
                    block_number: blockNumber,
                    source,
                };
                this.emit("pool_update", update);
            }
            catch (error) {
                this.log.error({ poolId: subscription.poolId, error }, "v3 pool polling failed");
            }
        }));
    }
}
function estimateV3Reserves(sqrtPriceX96, liquidity) {
    if (sqrtPriceX96 === 0n || liquidity === 0n) {
        return [0n, 0n];
    }
    const q96 = 2n ** 96n;
    const reserveIn = liquidity * q96 / sqrtPriceX96;
    const reserveOut = liquidity * sqrtPriceX96 / q96;
    return [reserveIn, reserveOut];
}
