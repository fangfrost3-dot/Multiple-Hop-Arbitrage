// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FlashLoanExecutor} from "./FlashLoanExecutor.sol";
import {MockDexAdapter} from "./test/MockDexAdapter.sol";
import {MockERC20} from "./test/MockERC20.sol";
import {MockFlashLender} from "./test/MockFlashLender.sol";
import {Test} from "forge-std/Test.sol";

contract FlashLoanExecutorTest is Test {
  MockERC20 baseToken;
  MockERC20 quoteToken;
  MockFlashLender lender;
  MockDexAdapter profitableAdapter;
  MockDexAdapter returnAdapter;
  FlashLoanExecutor executor;
  address profitRecipient = address(0xBEEF);

  function setUp() public {
    baseToken = new MockERC20("Base", "BASE", 18);
    quoteToken = new MockERC20("Quote", "QUOTE", 18);
    lender = new MockFlashLender(9);
    profitableAdapter = new MockDexAdapter(11_000);
    returnAdapter = new MockDexAdapter(10_000);
    executor = new FlashLoanExecutor(address(lender));

    baseToken.mint(address(lender), 1_000_000 ether);
    quoteToken.mint(address(profitableAdapter), 1_000_000 ether);
    baseToken.mint(address(returnAdapter), 1_000_000 ether);
  }

  function test_ProfitableFlashLoanPaysRecipient() public {
    FlashLoanExecutor.SwapInstruction[] memory swaps = new FlashLoanExecutor.SwapInstruction[](2);
    swaps[0] = FlashLoanExecutor.SwapInstruction({
      adapter: address(profitableAdapter),
      tokenIn: address(baseToken),
      tokenOut: address(quoteToken),
      routeData: ""
    });
    swaps[1] = FlashLoanExecutor.SwapInstruction({
      adapter: address(returnAdapter),
      tokenIn: address(quoteToken),
      tokenOut: address(baseToken),
      routeData: ""
    });

    FlashLoanExecutor.ExecutionPlan memory plan = FlashLoanExecutor.ExecutionPlan({
      profitToken: address(baseToken),
      minProfit: 5 ether,
      profitRecipient: profitRecipient,
      swaps: swaps
    });

    executor.requestFlashLoan(address(baseToken), 100 ether, abi.encode(plan));

    assertGt(baseToken.balanceOf(profitRecipient), 5 ether);
  }

  function test_RevertsWhenProfitBelowThreshold() public {
    FlashLoanExecutor.SwapInstruction[] memory swaps = new FlashLoanExecutor.SwapInstruction[](2);
    swaps[0] = FlashLoanExecutor.SwapInstruction({
      adapter: address(returnAdapter),
      tokenIn: address(baseToken),
      tokenOut: address(quoteToken),
      routeData: ""
    });
    swaps[1] = FlashLoanExecutor.SwapInstruction({
      adapter: address(returnAdapter),
      tokenIn: address(quoteToken),
      tokenOut: address(baseToken),
      routeData: ""
    });

    FlashLoanExecutor.ExecutionPlan memory plan = FlashLoanExecutor.ExecutionPlan({
      profitToken: address(baseToken),
      minProfit: 1 ether,
      profitRecipient: profitRecipient,
      swaps: swaps
    });

    vm.expectRevert();
    executor.requestFlashLoan(address(baseToken), 100 ether, abi.encode(plan));
  }

  function test_RevertsWhenProfitTokenDiffersFromBorrowedAsset() public {
    FlashLoanExecutor.SwapInstruction[] memory swaps = new FlashLoanExecutor.SwapInstruction[](2);
    swaps[0] = FlashLoanExecutor.SwapInstruction({
      adapter: address(profitableAdapter),
      tokenIn: address(baseToken),
      tokenOut: address(quoteToken),
      routeData: ""
    });
    swaps[1] = FlashLoanExecutor.SwapInstruction({
      adapter: address(returnAdapter),
      tokenIn: address(quoteToken),
      tokenOut: address(baseToken),
      routeData: ""
    });

    FlashLoanExecutor.ExecutionPlan memory plan = FlashLoanExecutor.ExecutionPlan({
      profitToken: address(quoteToken),
      minProfit: 1 ether,
      profitRecipient: profitRecipient,
      swaps: swaps
    });

    vm.expectRevert(FlashLoanExecutor.InvalidProfitToken.selector);
    executor.requestFlashLoan(address(baseToken), 100 ether, abi.encode(plan));
  }

  function test_PreExistingBalanceIsNotCountedAsProfit() public {
    FlashLoanExecutor.SwapInstruction[] memory swaps = new FlashLoanExecutor.SwapInstruction[](2);
    swaps[0] = FlashLoanExecutor.SwapInstruction({
      adapter: address(returnAdapter),
      tokenIn: address(baseToken),
      tokenOut: address(quoteToken),
      routeData: ""
    });
    swaps[1] = FlashLoanExecutor.SwapInstruction({
      adapter: address(returnAdapter),
      tokenIn: address(quoteToken),
      tokenOut: address(baseToken),
      routeData: ""
    });

    FlashLoanExecutor.ExecutionPlan memory plan = FlashLoanExecutor.ExecutionPlan({
      profitToken: address(baseToken),
      minProfit: 1 ether,
      profitRecipient: profitRecipient,
      swaps: swaps
    });

    baseToken.mint(address(executor), 20 ether);

    vm.expectRevert();
    executor.requestFlashLoan(address(baseToken), 100 ether, abi.encode(plan));
    assertEq(baseToken.balanceOf(profitRecipient), 0);
  }
}
