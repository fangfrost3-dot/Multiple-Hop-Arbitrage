// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockERC20} from "../test/MockERC20.sol";
import {MockUniswapV2Router} from "../test/MockUniswapV2Router.sol";
import {MockUniswapV3Router} from "../test/MockUniswapV3Router.sol";
import {Test} from "forge-std/Test.sol";
import {UniswapV2Adapter} from "./UniswapV2Adapter.sol";
import {UniswapV3Adapter} from "./UniswapV3Adapter.sol";

contract UniswapAdaptersTest is Test {
  MockERC20 tokenA;
  MockERC20 tokenB;
  MockUniswapV2Router v2Router;
  MockUniswapV3Router v3Router;
  UniswapV2Adapter v2Adapter;
  UniswapV3Adapter v3Adapter;

  function setUp() public {
    tokenA = new MockERC20("TokenA", "A", 18);
    tokenB = new MockERC20("TokenB", "B", 18);
    v2Router = new MockUniswapV2Router(10_500);
    v3Router = new MockUniswapV3Router(10_200);
    v2Adapter = new UniswapV2Adapter();
    v3Adapter = new UniswapV3Adapter();

    tokenA.mint(address(this), 1_000 ether);
    tokenB.mint(address(v2Router), 1_000 ether);
    tokenB.mint(address(v3Router), 1_000 ether);
  }

  function test_UniswapV2AdapterExecutesSwap() public {
    tokenA.approve(address(v2Adapter), 10 ether);
    address[] memory path = new address[](2);
    path[0] = address(tokenA);
    path[1] = address(tokenB);

    bytes memory routeData = abi.encode(
      UniswapV2Adapter.RouteData({router: address(v2Router), path: path, amountOutMin: 0, deadline: block.timestamp})
    );

    uint256 amountOut = v2Adapter.executeSwap(address(tokenA), address(tokenB), 10 ether, routeData);
    assertEq(amountOut, 10.5 ether);
    assertEq(tokenB.balanceOf(address(this)), 10.5 ether);
  }

  function test_UniswapV3AdapterExecutesSwap() public {
    tokenA.approve(address(v3Adapter), 10 ether);

    bytes memory routeData = abi.encode(
      UniswapV3Adapter.RouteData({
        router: address(v3Router),
        fee: 500,
        amountOutMin: 0,
        deadline: block.timestamp,
        sqrtPriceLimitX96: 0
      })
    );

    uint256 amountOut = v3Adapter.executeSwap(address(tokenA), address(tokenB), 10 ether, routeData);
    assertEq(amountOut, 10.2 ether);
    assertEq(tokenB.balanceOf(address(this)), 10.2 ether);
  }
}
