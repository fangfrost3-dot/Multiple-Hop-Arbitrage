// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDexAdapter} from "../interfaces/IDexAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";

contract OneInchAdapter is IDexAdapter {
  struct RouteData {
    address router;
    bytes data;
  }

  error InvalidRouter();
  error NativeValueNotSupported();
  error RouterCallFailed(bytes reason);

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

    IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
    IERC20(tokenIn).approve(route.router, amountIn);

    uint256 receiverBalanceBefore = IERC20(tokenOut).balanceOf(msg.sender);
    (bool success, bytes memory result) = route.router.call(route.data);
    if (!success) {
      revert RouterCallFailed(result);
    }
    if (address(this).balance != 0) {
      revert NativeValueNotSupported();
    }

    uint256 receiverBalanceAfter = IERC20(tokenOut).balanceOf(msg.sender);
    amountOut = receiverBalanceAfter - receiverBalanceBefore;
  }
}
