// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "../interfaces/IERC20.sol";
import {IUniswapV2RouterLike} from "../interfaces/IUniswapV2RouterLike.sol";

contract MockUniswapV2Router is IUniswapV2RouterLike {
  uint256 public immutable multiplierBps;

  constructor(uint256 multiplierBps_) {
    multiplierBps = multiplierBps_;
  }

  function swapExactTokensForTokens(
    uint256 amountIn,
    uint256,
    address[] calldata path,
    address to,
    uint256
  ) external override returns (uint256[] memory amounts) {
    IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);

    amounts = new uint256[](path.length);
    amounts[0] = amountIn;

    uint256 running = amountIn;
    for (uint256 i = 1; i < path.length; i++) {
      running = (running * multiplierBps) / 10_000;
      amounts[i] = running;
    }

    IERC20(path[path.length - 1]).transfer(to, running);
  }
}
