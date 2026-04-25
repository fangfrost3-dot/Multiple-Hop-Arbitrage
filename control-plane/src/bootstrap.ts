import { Contract, Interface, JsonRpcProvider } from "ethers";
import { curveTwoCoinPoolAbi, multicall3Abi, uniswapV2PairAbi, uniswapV3PoolAbi } from "./abis.js";
import { expandV2Pools, filterStablePools } from "./discovery.js";
import { createLogger } from "./logger.js";
import type { PoolConfig, PoolSnapshot, StablePoolConfig, V2PoolConfig, V3PoolConfig } from "./types.js";

const log = createLogger("bootstrap");

interface BootstrapOptions {
  rpcUrl: string | undefined;
  multicall3Address?: string | undefined;
  pools: PoolConfig[];
}

interface BatchCall {
  target: string;
  iface: Interface;
  fn: string;
  args: unknown[];
}

export async function loadBootstrapPools(options: BootstrapOptions): Promise<PoolSnapshot[]> {
  const { rpcUrl, multicall3Address, pools } = options;
  if (!rpcUrl || pools.length === 0) {
    log.info({ rpcUrlConfigured: Boolean(rpcUrl), poolCount: pools.length }, "using fallback bootstrap pools");
    return fallbackPools();
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const expandedPools = await expandV2Pools(provider, multicall3Address, pools);
  const stablePools = filterStablePools(pools);
  const v3Pools = pools.filter((pool): pool is V3PoolConfig => pool.kind === "v3");
  const snapshots = await loadPoolSnapshots(provider, multicall3Address, expandedPools, stablePools, v3Pools);
  return snapshots;
}

async function loadPoolSnapshots(
  provider: JsonRpcProvider,
  multicall3Address: string | undefined,
  pools: V2PoolConfig[],
  stablePools: StablePoolConfig[],
  v3Pools: V3PoolConfig[],
): Promise<PoolSnapshot[]> {
  const pairInterface = new Interface(uniswapV2PairAbi);
  const reserveCalls: BatchCall[] = pools.map((pool) => ({
    target: pool.pair,
    iface: pairInterface,
    fn: "getReserves",
    args: [],
  }));
  const token0Calls: BatchCall[] = pools.map((pool) => ({
    target: pool.pair,
    iface: pairInterface,
    fn: "token0",
    args: [],
  }));

  const [reserveResults, token0Results] = await Promise.all([
    batchRead(provider, multicall3Address, reserveCalls),
    batchRead(provider, multicall3Address, token0Calls),
  ]);

  const v2Snapshots: PoolSnapshot[] = pools.map((pool, index) => {
    const reserves = reserveResults[index];
    const token0 = String(token0Results[index]?.[0] ?? "");
    const reserve0 = BigInt(String(reserves?.[0] ?? 0));
    const reserve1 = BigInt(String(reserves?.[1] ?? 0));
    const tokenInIsToken0 = token0.toLowerCase() === pool.tokenIn.toLowerCase();
    const reserveIn = tokenInIsToken0 ? reserve0 : reserve1;
    const reserveOut = tokenInIsToken0 ? reserve1 : reserve0;

    return {
      pool_id: pool.poolId,
      dex: pool.dex,
      pool_kind: "xyk",
      amp_factor: undefined,
      token_in: pool.tokenIn,
      token_out: pool.tokenOut,
      reserve_in: reserveIn.toString(),
      reserve_out: reserveOut.toString(),
      fee_bps: pool.feeBps,
    };
  });

  const stableSnapshots: PoolSnapshot[] = stablePools.map((pool) => ({
      pool_id: pool.poolId,
      dex: pool.dex,
      pool_kind: "stable",
      amp_factor: pool.ampFactor,
      token_in: pool.tokenIn,
      token_out: pool.tokenOut,
      reserve_in: pool.reserveIn,
      reserve_out: pool.reserveOut,
      fee_bps: pool.feeBps,
    }));

  const v3Snapshots: PoolSnapshot[] = v3Pools.map((pool) => ({
    pool_id: pool.poolId,
    dex: pool.dex,
    pool_kind: "xyk",
    amp_factor: undefined,
    token_in: pool.tokenIn,
    token_out: pool.tokenOut,
    reserve_in: "0",
    reserve_out: "0",
    fee_bps: pool.feeBps,
  }));

  await hydrateStableSnapshots(provider, stablePools, stableSnapshots);
  await hydrateV3Snapshots(provider, v3Pools, v3Snapshots);

  return v2Snapshots.concat(stableSnapshots, v3Snapshots);
}

async function hydrateStableSnapshots(
  provider: JsonRpcProvider,
  stablePools: StablePoolConfig[],
  stableSnapshots: PoolSnapshot[],
): Promise<void> {
  const pollablePools = stablePools
    .map((pool, index) => ({ pool, index }))
    .filter(({ pool }) => pool.poolAddress && pool.handler === "curve_two_coin");

  await Promise.all(
    pollablePools.map(async ({ pool, index }) => {
      const contract = new Contract(pool.poolAddress!, curveTwoCoinPoolAbi, provider);
      const [reserveIn, reserveOut] = await Promise.all([contract.balances(0), contract.balances(1)]);
      stableSnapshots[index] = {
        ...stableSnapshots[index],
        reserve_in: reserveIn.toString(),
        reserve_out: reserveOut.toString(),
      };
    }),
  );
}

async function hydrateV3Snapshots(
  provider: JsonRpcProvider,
  v3Pools: V3PoolConfig[],
  v3Snapshots: PoolSnapshot[],
): Promise<void> {
  await Promise.all(
    v3Pools.map(async (pool, index) => {
      const contract = new Contract(pool.poolAddress, uniswapV3PoolAbi, provider);
      const [slot0, liquidity] = await Promise.all([contract.slot0(), contract.liquidity()]);
      const [reserveIn, reserveOut] = estimateV3Reserves(BigInt(slot0.sqrtPriceX96), BigInt(liquidity));
      v3Snapshots[index] = {
        ...v3Snapshots[index],
        reserve_in: reserveIn.toString(),
        reserve_out: reserveOut.toString(),
      };
    }),
  );
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

async function batchRead(
  provider: JsonRpcProvider,
  multicall3Address: string | undefined,
  calls: BatchCall[],
): Promise<unknown[][]> {
  if (calls.length === 0) {
    return [];
  }

  if (!multicall3Address) {
    const results = await Promise.all(
      calls.map(async (call) => {
        const encoded = call.iface.encodeFunctionData(call.fn, call.args);
        const response = await provider.call({ to: call.target, data: encoded });
        return call.iface.decodeFunctionResult(call.fn, response).toArray();
      }),
    );
    return results;
  }

  const multicall = new Contract(multicall3Address, multicall3Abi, provider);
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
      log.error({ target: calls[index]?.target, fn: calls[index]?.fn }, "multicall read failed");
      return [];
    }
    return calls[index].iface.decodeFunctionResult(calls[index].fn, response.returnData).toArray();
  });
}

function fallbackPools(): PoolSnapshot[] {
  return [
    {
      pool_id: "pool-a",
      dex: "uniswap-v2",
      pool_kind: "xyk",
      amp_factor: undefined,
      token_in: "WETH",
      token_out: "USDC",
      reserve_in: "1500000000000",
      reserve_out: "2500000000000000",
      fee_bps: 30,
    },
    {
      pool_id: "pool-b",
      dex: "sushiswap",
      pool_kind: "xyk",
      amp_factor: undefined,
      token_in: "USDC",
      token_out: "ARB",
      reserve_in: "2500000000000000",
      reserve_out: "4000000000000",
      fee_bps: 30,
    },
    {
      pool_id: "pool-c",
      dex: "camelot",
      pool_kind: "xyk",
      amp_factor: undefined,
      token_in: "ARB",
      token_out: "WETH",
      reserve_in: "4000000000000",
      reserve_out: "1600000000000",
      fee_bps: 30,
    },
  ] satisfies PoolSnapshot[];
}
