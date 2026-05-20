// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDexAdapter} from "../interfaces/IDexAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {SafeERC20} from "../libraries/SafeERC20.sol";

contract OneInchAdapter is IDexAdapter {
  using SafeERC20 for address;

  struct RouteData {
    address router;
    bytes data;
  }

  error InvalidRouter();
  error NativeValueNotSupported();
  error RouterCallFailed(bytes reason);
  error InsufficientOutput(uint256 amountOut);

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
    (bool success, bytes memory result) = route.router.call(route.data);
    tokenIn.forceApprove(route.router, 0);
    if (!success) {
      revert RouterCallFailed(result);
    }
    if (address(this).balance != 0) {
      revert NativeValueNotSupported();
    }

    uint256 receiverBalanceAfter = IERC20(tokenOut).balanceOf(msg.sender);
    amountOut = receiverBalanceAfter - receiverBalanceBefore;
    if (amountOut == 0) {
      revert InsufficientOutput(amountOut);
    }
  }
}
