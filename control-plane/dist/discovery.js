import { Contract, Interface, ZeroAddress } from "ethers";
import { multicall3Abi, uniswapV2FactoryAbi } from "./abis.js";
export async function expandV2Pools(provider, multicall3Address, pools) {
    const directPools = pools.filter((pool) => pool.kind === "v2");
    const factories = pools.filter((pool) => pool.kind === "v2_factory");
    if (factories.length === 0) {
        return directPools;
    }
    const factoryInterface = new Interface(uniswapV2FactoryAbi);
    const calls = [];
    const metadata = [];
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
    const results = await batchRead(provider, multicall3Address, calls);
    const discovered = [];
    for (let i = 0; i < results.length; i++) {
        const pair = results[i]?.[0];
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
export function filterStablePools(pools) {
    return pools.filter((pool) => pool.kind === "stable");
}
async function batchRead(provider, multicall3Address, calls) {
    if (calls.length === 0) {
        return [];
    }
    if (!multicall3Address) {
        return Promise.all(calls.map(async (call) => {
            const encoded = call.iface.encodeFunctionData(call.fn, call.args);
            const response = await provider.call({ to: call.target, data: encoded });
            return call.iface.decodeFunctionResult(call.fn, response).toArray();
        }));
    }
    const multicall = new Contract(multicall3Address, multicall3Abi, provider);
    const aggregateCalls = calls.map((call) => ({
        target: call.target,
        allowFailure: true,
        callData: call.iface.encodeFunctionData(call.fn, call.args),
    }));
    const responses = (await multicall.aggregate3.staticCall(aggregateCalls));
    return responses.map((response, index) => {
        if (!response.success) {
            return [];
        }
        return calls[index].iface.decodeFunctionResult(calls[index].fn, response.returnData).toArray();
    });
}
