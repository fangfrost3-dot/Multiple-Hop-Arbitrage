// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDexAdapter} from "./interfaces/IDexAdapter.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IFlashLoanSimpleReceiver} from "./interfaces/IFlashLoanSimpleReceiver.sol";
import {IPool} from "./interfaces/IPool.sol";

contract FlashLoanExecutor is IFlashLoanSimpleReceiver {
  error NotOwner();
  error InvalidLender();
  error InvalidInitiator();
  error InvalidRoute();
  error InvalidProfitToken();
  error InsufficientProfit(uint256 finalBalance, uint256 minReturn);

  struct SwapInstruction {
    address adapter;
    address tokenIn;
    address tokenOut;
    bytes routeData;
  }

  struct ExecutionPlan {
    address profitToken;
    uint256 minProfit;
    address profitRecipient;
    SwapInstruction[] swaps;
  }

  address public immutable owner;
  IPool public immutable lender;

  event FlashLoanRequested(address indexed asset, uint256 amount);
  event ArbitrageExecuted(address indexed asset, uint256 amountBorrowed, uint256 amountRepaid, uint256 profit);

  constructor(address lenderAddress) {
    owner = msg.sender;
    lender = IPool(lenderAddress);
  }

  modifier onlyOwner() {
    if (msg.sender != owner) {
      revert NotOwner();
    }
    _;
  }

  function requestFlashLoan(address asset, uint256 amount, bytes calldata params) external onlyOwner {
    emit FlashLoanRequested(asset, amount);
    lender.flashLoanSimple(address(this), asset, amount, params, 0);
  }

  function executeOperation(
    address asset,
    uint256 amount,
    uint256 premium,
    address initiator,
    bytes calldata params
  ) external override returns (bool) {
    if (msg.sender != address(lender)) {
      revert InvalidLender();
    }
    if (initiator != address(this)) {
      revert InvalidInitiator();
    }

    ExecutionPlan memory plan = abi.decode(params, (ExecutionPlan));
    if (plan.swaps.length == 0) {
      revert InvalidRoute();
    }
    if (plan.profitToken != asset) {
      revert InvalidProfitToken();
    }

    uint256 startingBalance = IERC20(asset).balanceOf(address(this));
    uint256 currentAmount = amount;
    for (uint256 i = 0; i < plan.swaps.length; i++) {
      SwapInstruction memory instruction = plan.swaps[i];
      IERC20(instruction.tokenIn).approve(instruction.adapter, currentAmount);
      currentAmount = IDexAdapter(instruction.adapter).executeSwap(
        instruction.tokenIn,
        instruction.tokenOut,
        currentAmount,
        instruction.routeData
      );
    }

    uint256 amountOwed = amount + premium;
    uint256 finalBalance = IERC20(asset).balanceOf(address(this));
    uint256 minReturn = startingBalance + premium + plan.minProfit;
    if (finalBalance < minReturn) {
      revert InsufficientProfit(finalBalance, minReturn);
    }

    IERC20(asset).approve(address(lender), amountOwed);

    uint256 profit = finalBalance - startingBalance - premium;
    if (profit > 0) {
      IERC20(plan.profitToken).transfer(plan.profitRecipient, profit);
    }

    emit ArbitrageExecuted(asset, amount, amountOwed, profit);
    return true;
  }
}
