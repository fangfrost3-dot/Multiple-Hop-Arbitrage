// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDexAdapter} from "../interfaces/IDexAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {SafeERC20} from "../libraries/SafeERC20.sol";

contract UniswapV3Adapter is IDexAdapter {
  using SafeERC20 for address;

  struct RouteData {
    address router;
    uint24 fee;
    uint256 amountOutMin;
    uint256 deadline;
    uint160 sqrtPriceLimitX96;
  }

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

    tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
    tokenIn.forceApprove(route.router, amountIn);

    uint256 receiverBalanceBefore = IERC20(tokenOut).balanceOf(msg.sender);
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

    uint256 routerAmountOut = ISwapRouter(route.router).exactInputSingle(params);
    tokenIn.forceApprove(route.router, 0);
    uint256 receiverBalanceAfter = IERC20(tokenOut).balanceOf(msg.sender);
    amountOut = receiverBalanceAfter - receiverBalanceBefore;
    if (amountOut < route.amountOutMin || amountOut != routerAmountOut) {
      revert InsufficientOutput(amountOut, route.amountOutMin);
    }
  }
}
