export const uniswapV2PairAbi = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "event Sync(uint112 reserve0, uint112 reserve1)",
];

export const uniswapV2FactoryAbi = [
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
];

export const multicall3Abi = [
  "function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)",
];

export const curveTwoCoinPoolAbi = [
  "function balances(uint256) view returns (uint256)",
];

export const erc20Abi = [
  "function balanceOf(address account) view returns (uint256)",
];

export const uniswapV3PoolAbi = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
];
