// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDexAdapter} from "../interfaces/IDexAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";

contract MockDexAdapter is IDexAdapter {
  uint256 public immutable multiplierBps;

  constructor(uint256 multiplierBps_) {
    multiplierBps = multiplierBps_;
  }

  function executeSwap(
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    bytes calldata
  ) external override returns (uint256 amountOut) {
    IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
    amountOut = (amountIn * multiplierBps) / 10_000;
    IERC20(tokenOut).transfer(msg.sender, amountOut);
  }
}
