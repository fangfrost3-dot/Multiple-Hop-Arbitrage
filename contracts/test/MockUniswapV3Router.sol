// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "../interfaces/IERC20.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";

contract MockUniswapV3Router is ISwapRouter {
  uint256 public immutable multiplierBps;

  constructor(uint256 multiplierBps_) {
    multiplierBps = multiplierBps_;
  }

  function exactInputSingle(ExactInputSingleParams calldata params) external payable override returns (uint256 amountOut) {
    IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
    amountOut = (params.amountIn * multiplierBps) / 10_000;
    IERC20(params.tokenOut).transfer(params.recipient, amountOut);
  }
}
