// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDexAdapter} from "../interfaces/IDexAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {IUniswapV2RouterLike} from "../interfaces/IUniswapV2RouterLike.sol";

contract UniswapV2Adapter is IDexAdapter {
  struct RouteData {
    address router;
    address[] path;
    uint256 amountOutMin;
    uint256 deadline;
  }

  error InvalidPath();

  function executeSwap(
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    bytes calldata routeData
  ) external override returns (uint256 amountOut) {
    RouteData memory route = abi.decode(routeData, (RouteData));
    uint256 pathLength = route.path.length;
    if (pathLength < 2 || route.path[0] != tokenIn || route.path[pathLength - 1] != tokenOut) {
      revert InvalidPath();
    }

    IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
    IERC20(tokenIn).approve(route.router, amountIn);

    uint256[] memory amounts = IUniswapV2RouterLike(route.router).swapExactTokensForTokens(
      amountIn,
      route.amountOutMin,
      route.path,
      msg.sender,
      route.deadline
    );
    amountOut = amounts[amounts.length - 1];
  }
}
