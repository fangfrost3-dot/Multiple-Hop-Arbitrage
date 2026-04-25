// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "../interfaces/IERC20.sol";
import {IFlashLoanSimpleReceiver} from "../interfaces/IFlashLoanSimpleReceiver.sol";
import {IPool} from "../interfaces/IPool.sol";

contract MockFlashLender is IPool {
  uint256 public immutable premiumBps;

  constructor(uint256 premiumBps_) {
    premiumBps = premiumBps_;
  }

  function flashLoanSimple(
    address receiverAddress,
    address asset,
    uint256 amount,
    bytes calldata params,
    uint16
  ) external override {
    uint256 lenderBalanceBefore = IERC20(asset).balanceOf(address(this));
    IERC20(asset).transfer(receiverAddress, amount);

    uint256 premium = (amount * premiumBps) / 10_000;
    bool ok = IFlashLoanSimpleReceiver(receiverAddress).executeOperation(
      asset,
      amount,
      premium,
      receiverAddress,
      params
    );
    require(ok, "callback");

    IERC20(asset).transferFrom(receiverAddress, address(this), amount + premium);

    uint256 lenderBalanceAfter = IERC20(asset).balanceOf(address(this));
    require(lenderBalanceAfter >= lenderBalanceBefore + premium, "not repaid");
  }
}
