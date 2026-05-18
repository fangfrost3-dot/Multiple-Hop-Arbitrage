// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "../interfaces/IERC20.sol";

contract MockOneInchRouter {
  uint256 public immutable rateBps;

  constructor(uint256 rateBps_) {
    rateBps = rateBps_;
  }

  function swap(address tokenIn, address tokenOut, uint256 amountIn, address receiver) external returns (uint256 amountOut) {
    IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
    amountOut = (amountIn * rateBps) / 10_000;
    IERC20(tokenOut).transfer(receiver, amountOut);
  }
}
