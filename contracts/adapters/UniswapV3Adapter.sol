// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDexAdapter} from "../interfaces/IDexAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";

contract UniswapV3Adapter is IDexAdapter {
  struct RouteData {
    address router;
    uint24 fee;
    uint256 amountOutMin;
    uint256 deadline;
    uint160 sqrtPriceLimitX96;
  }

  function executeSwap(
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    bytes calldata routeData
  ) external override returns (uint256 amountOut) {
    RouteData memory route = abi.decode(routeData, (RouteData));

    IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
    IERC20(tokenIn).approve(route.router, amountIn);

    ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
      tokenIn: tokenIn,
      tokenOut: tokenOut,
      fee: route.fee,
      recipient: msg.sender,
      deadline: route.deadline,
      amountIn: amountIn,
      amountOutMinimum: route.amountOutMin,
      sqrtPriceLimitX96: route.sqrtPriceLimitX96
    });

    amountOut = ISwapRouter(route.router).exactInputSingle(params);
  }
}
