#!/usr/bin/env node
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, JsonRpcProvider, formatUnits } from "ethers";

const zeroAddress = "0x0000000000000000000000000000000000000000";
const erc20Abi = [
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
const factoryAbi = ["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)"];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const controlPlaneDir = resolve(scriptDir, "..");
const configArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const configPath = resolve(controlPlaneDir, configArg ?? "./config/route-generator.fork.json");
const dryRun = process.argv.includes("--dry-run");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function poolId(symbolIn, symbolOut, fee) {
  return `uni-${symbolIn.toLowerCase().replace(".", "")}-${symbolOut.toLowerCase().replace(".", "")}-v3-${fee}`;
}

function v3PoolEntry(id, address, tokenIn, tokenOut, fee) {
  return {
    kind: "v3",
    poolId: id,
    dex: "uniswap-v3",
    poolAddress: address,
    handler: "uniswap_v3",
    tokenIn,
    tokenOut,
    feeBps: fee / 100,
  };
}

function v3Swap(adapter, router, tokenIn, tokenOut, fee) {
  return {
    kind: "v3",
    adapter,
    tokenIn,
    tokenOut,
    router,
    fee,
    amountOutMin: "1",
    deadlineSeconds: 60,
    sqrtPriceLimitX96: "0",
  };
}

function addRoute(routes, routeIds, config, first, second, borrow, mid, feeA, feeB, maxBorrowAmount) {
  const cycleId = `${first}->${second}`;
  if (routeIds.has(cycleId)) {
    return false;
  }

  routes.push({
    cycleId,
    borrowToken: borrow,
    profitToken: borrow,
    minProfit: "0",
    swaps: [
      v3Swap(config.uniswapV3Adapter, config.uniswapV3Router, borrow, mid, feeA),
      v3Swap(config.uniswapV3Adapter, config.uniswapV3Router, mid, borrow, feeB),
    ],
    maxBorrowAmount,
  });
  routeIds.add(cycleId);
  return true;
}

async function main() {
  if (!existsSync(configPath)) {
    throw new Error(`generator config not found: ${configPath}`);
  }

  const rpcUrl = process.env.RPC_URL || process.env.FORK_RPC_URL;
  if (!rpcUrl) {
    throw new Error("RPC_URL or FORK_RPC_URL is required");
  }

  const config = readJson(configPath);
  const basePoolsPath = resolve(controlPlaneDir, config.basePoolsPath);
  const baseRoutesPath = resolve(controlPlaneDir, config.baseRoutesPath);
  const outputPoolsPath = resolve(controlPlaneDir, config.outputPoolsPath);
  const outputRoutesPath = resolve(controlPlaneDir, config.outputRoutesPath);
  const pools = readJson(basePoolsPath);
  const routes = readJson(baseRoutesPath);
  const poolIds = new Set(pools.map((pool) => pool.poolId));
  const routeIds = new Set(routes.map((route) => route.cycleId));
  const provider = new JsonRpcProvider(rpcUrl);
  const factory = new Contract(config.uniswapV3Factory, factoryAbi, provider);
  const discovered = new Map();
  let addedPools = 0;
  let addedRoutes = 0;

  for (const [symbolA, symbolB] of config.pairs) {
    const tokenA = config.tokens[symbolA];
    const tokenB = config.tokens[symbolB];
    if (!tokenA || !tokenB) {
      throw new Error(`pair references unknown token: ${symbolA}/${symbolB}`);
    }

    for (const fee of config.feeTiers) {
      const address = await factory.getPool(tokenA.address, tokenB.address, fee);
      if (address === zeroAddress) {
        continue;
      }

      const contractA = new Contract(tokenA.address, erc20Abi, provider);
      const contractB = new Contract(tokenB.address, erc20Abi, provider);
      const [balanceA, balanceB, decimalsA, decimalsB] = await Promise.all([
        contractA.balanceOf(address),
        contractB.balanceOf(address),
        contractA.decimals(),
        contractB.decimals(),
      ]);
      const amountA = Number(formatUnits(balanceA, decimalsA));
      const amountB = Number(formatUnits(balanceB, decimalsB));
      const tvlUsd = amountA * Number(tokenA.priceUsd) + amountB * Number(tokenB.priceUsd);
      const maxPoolTvlUsd = Number(config.maxPoolTvlUsd ?? 0);
      const isAllowed =
        tvlUsd >= Number(config.minPoolTvlUsd ?? 0) &&
        (maxPoolTvlUsd <= 0 || tvlUsd <= maxPoolTvlUsd);

      console.log(
        `${symbolA}/${symbolB} ${fee}: ${address} tvl~$${Math.round(tvlUsd).toLocaleString()} ${isAllowed ? "keep" : "skip"}`,
      );

      if (!isAllowed) {
        continue;
      }

      const forwardId = poolId(symbolA, symbolB, fee);
      const reverseId = poolId(symbolB, symbolA, fee);
      discovered.set(forwardId, { id: forwardId, reverseId, symbolA, symbolB, tokenA, tokenB, fee });

      if (!poolIds.has(forwardId)) {
        pools.push(v3PoolEntry(forwardId, address, tokenA.address, tokenB.address, fee));
        poolIds.add(forwardId);
        addedPools += 1;
      }
      if (!poolIds.has(reverseId)) {
        pools.push(v3PoolEntry(reverseId, address, tokenB.address, tokenA.address, fee));
        poolIds.add(reverseId);
        addedPools += 1;
      }
    }
  }

  for (const [symbolA, symbolB] of config.pairs) {
    for (const feeA of config.feeTiers) {
      for (const feeB of config.feeTiers) {
        if (feeA >= feeB) {
          continue;
        }

        const abA = poolId(symbolA, symbolB, feeA);
        const abB = poolId(symbolA, symbolB, feeB);
        const baA = poolId(symbolB, symbolA, feeA);
        const baB = poolId(symbolB, symbolA, feeB);
        const tokenA = config.tokens[symbolA];
        const tokenB = config.tokens[symbolB];

        if (!poolIds.has(abA) || !poolIds.has(abB) || !poolIds.has(baA) || !poolIds.has(baB)) {
          continue;
        }

        addedRoutes += Number(addRoute(routes, routeIds, config, abA, baB, tokenA.address, tokenB.address, feeA, feeB, tokenA.maxBorrowAmount));
        addedRoutes += Number(addRoute(routes, routeIds, config, abB, baA, tokenA.address, tokenB.address, feeB, feeA, tokenA.maxBorrowAmount));
        addedRoutes += Number(addRoute(routes, routeIds, config, baA, abB, tokenB.address, tokenA.address, feeA, feeB, tokenB.maxBorrowAmount));
        addedRoutes += Number(addRoute(routes, routeIds, config, baB, abA, tokenB.address, tokenA.address, feeB, feeA, tokenB.maxBorrowAmount));
      }
    }
  }

  console.log(JSON.stringify({ addedPools, addedRoutes, pools: pools.length, routes: routes.length }, null, 2));
  if (!dryRun) {
    writeJson(outputPoolsPath, pools);
    writeJson(outputRoutesPath, routes);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
