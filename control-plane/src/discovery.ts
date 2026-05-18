import { Contract, Interface, JsonRpcProvider, ZeroAddress } from "ethers";
import { multicall3Abi, uniswapV2FactoryAbi } from "./abis.js";
import type { CuMeter } from "./cuMeter.js";
import type { PoolConfig, StablePoolConfig, V2FactoryConfig, V2PoolConfig } from "./types.js";

interface BatchCall {
  target: string;
  iface: Interface;
  fn: string;
  args: unknown[];
}

export async function expandV2Pools(
  provider: JsonRpcProvider,
  multicall3Address: string | undefined,
  pools: PoolConfig[],
  cuMeter?: CuMeter,
): Promise<V2PoolConfig[]> {
  const directPools = pools.filter((pool): pool is V2PoolConfig => pool.kind === "v2");
  const factories = pools.filter((pool): pool is V2FactoryConfig => pool.kind === "v2_factory");
  if (factories.length === 0) {
    return directPools;
  }

  const factoryInterface = new Interface(uniswapV2FactoryAbi);
  const calls: BatchCall[] = [];
  const metadata: Array<{ dex: string; tokenA: string; tokenB: string; feeBps: number }> = [];

  for (const factory of factories) {
    for (let i = 0; i < factory.tokens.length; i++) {
      for (let j = i + 1; j < factory.tokens.length; j++) {
        const tokenA = factory.tokens[i];
        const tokenB = factory.tokens[j];
        calls.push({
          target: factory.factory,
          iface: factoryInterface,
          fn: "getPair",
          args: [tokenA, tokenB],
        });
        metadata.push({
          dex: factory.dex,
          tokenA,
          tokenB,
          feeBps: factory.feeBps,
        });
      }
    }
  }

  const results = await batchRead(provider, multicall3Address, calls, cuMeter);
  const discovered: V2PoolConfig[] = [];
  for (let i = 0; i < results.length; i++) {
    const pair = results[i]?.[0] as string | undefined;
    if (!pair || pair === ZeroAddress) {
      continue;
    }
    const meta = metadata[i];
    discovered.push({
      kind: "v2",
      dex: meta.dex,
      pair,
      tokenIn: meta.tokenA,
      tokenOut: meta.tokenB,
      feeBps: meta.feeBps,
      poolId: `${meta.dex}:${pair.toLowerCase()}`,
    });
    discovered.push({
      kind: "v2",
      dex: meta.dex,
      pair,
      tokenIn: meta.tokenB,
      tokenOut: meta.tokenA,
      feeBps: meta.feeBps,
      poolId: `${meta.dex}:${pair.toLowerCase()}:reverse`,
    });
  }

  return [...directPools, ...discovered];
}

export function filterStablePools(pools: PoolConfig[]): StablePoolConfig[] {
  return pools.filter((pool): pool is StablePoolConfig => pool.kind === "stable");
}

async function batchRead(
  provider: JsonRpcProvider,
  multicall3Address: string | undefined,
  calls: BatchCall[],
  cuMeter?: CuMeter,
): Promise<unknown[][]> {
  if (calls.length === 0) {
    return [];
  }

  if (!multicall3Address) {
    cuMeter?.recordMethod("eth_call", calls.length);
    return Promise.all(
      calls.map(async (call) => {
        const encoded = call.iface.encodeFunctionData(call.fn, call.args);
        const response = await provider.call({ to: call.target, data: encoded });
        return call.iface.decodeFunctionResult(call.fn, response).toArray();
      }),
    );
  }

  const multicall = new Contract(multicall3Address, multicall3Abi, provider);
  cuMeter?.recordMethod("eth_call");
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
      return [];
    }
    return calls[index].iface.decodeFunctionResult(calls[index].fn, response.returnData).toArray();
  });
}
