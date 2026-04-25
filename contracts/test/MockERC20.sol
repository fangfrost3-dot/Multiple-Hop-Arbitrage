// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "../interfaces/IERC20.sol";

contract MockERC20 is IERC20 {
  string public name;
  string public symbol;
  uint8 public immutable decimals;

  mapping(address => uint256) public override balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  constructor(string memory tokenName, string memory tokenSymbol, uint8 tokenDecimals) {
    name = tokenName;
    symbol = tokenSymbol;
    decimals = tokenDecimals;
  }

  function mint(address to, uint256 value) external {
    balanceOf[to] += value;
  }

  function transfer(address to, uint256 value) external override returns (bool) {
    _transfer(msg.sender, to, value);
    return true;
  }

  function approve(address spender, uint256 value) external override returns (bool) {
    allowance[msg.sender][spender] = value;
    return true;
  }

  function transferFrom(address from, address to, uint256 value) external override returns (bool) {
    uint256 allowed = allowance[from][msg.sender];
    require(allowed >= value, "allowance");
    allowance[from][msg.sender] = allowed - value;
    _transfer(from, to, value);
    return true;
  }

  function _transfer(address from, address to, uint256 value) internal {
    require(balanceOf[from] >= value, "balance");
    balanceOf[from] -= value;
    balanceOf[to] += value;
  }
}
