// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDexAdapter} from "../interfaces/IDexAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {IUniswapV2RouterLike} from "../interfaces/IUniswapV2RouterLike.sol";
import {SafeERC20} from "../libraries/SafeERC20.sol";

contract UniswapV2Adapter is IDexAdapter {
  using SafeERC20 for address;

  struct RouteData {
    address router;
    address[] path;
    uint256 amountOutMin;
    uint256 deadline;
  }

  error InvalidPath();
  error InvalidRouter();
  error InsufficientOutput(uint256 amountOut, uint256 amountOutMin);

  function executeSwap(
    address tokenIn,
    address tokenOut,
    uint256 amountIn,
    bytes calldata routeData
  ) external override returns (uint256 amountOut) {
    RouteData memory route = abi.decode(routeData, (RouteData));
    if (route.router == address(0)) {
      revert InvalidRouter();
    }
    uint256 pathLength = route.path.length;
    if (pathLength < 2 || route.path[0] != tokenIn || route.path[pathLength - 1] != tokenOut) {
      revert InvalidPath();
    }

    tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
    tokenIn.forceApprove(route.router, amountIn);

    uint256 receiverBalanceBefore = IERC20(tokenOut).balanceOf(msg.sender);
    uint256[] memory amounts = IUniswapV2RouterLike(route.router).swapExactTokensForTokens(
      amountIn,
      route.amountOutMin,
      route.path,
      msg.sender,
      route.deadline
    );
    tokenIn.forceApprove(route.router, 0);
    uint256 receiverBalanceAfter = IERC20(tokenOut).balanceOf(msg.sender);
    amountOut = receiverBalanceAfter - receiverBalanceBefore;
    if (amountOut < route.amountOutMin || amountOut != amounts[amounts.length - 1]) {
      revert InsufficientOutput(amountOut, route.amountOutMin);
    }
  }
}
