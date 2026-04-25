// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IDexAdapter {
  function executeSwap(
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    bytes calldata routeData
  ) external returns (uint256 amountOut);
}
