// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockERC20} from "../test/MockERC20.sol";
import {MockOneInchRouter} from "../test/MockOneInchRouter.sol";
import {Test} from "forge-std/Test.sol";
import {OneInchAdapter} from "./OneInchAdapter.sol";

contract OneInchAdapterTest is Test {
  MockERC20 tokenA;
  MockERC20 tokenB;
  MockOneInchRouter router;
  OneInchAdapter adapter;

  function setUp() public {
    tokenA = new MockERC20("TokenA", "A", 18);
    tokenB = new MockERC20("TokenB", "B", 18);
    router = new MockOneInchRouter(10_300);
    adapter = new OneInchAdapter();

    tokenA.mint(address(this), 1_000 ether);
    tokenB.mint(address(router), 1_000 ether);
  }

  function test_OneInchAdapterExecutesSwap() public {
    tokenA.approve(address(adapter), 10 ether);

    bytes memory routeData = abi.encode(
      OneInchAdapter.RouteData({
        router: address(router),
        data: abi.encodeCall(MockOneInchRouter.swap, (address(tokenA), address(tokenB), 10 ether, address(this)))
      })
    );

    uint256 amountOut = adapter.executeSwap(address(tokenA), address(tokenB), 10 ether, routeData);
    assertEq(amountOut, 10.3 ether);
    assertEq(tokenB.balanceOf(address(this)), 10.3 ether);
  }
}
