// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library SafeERC20 {
  error ERC20CallFailed(address token, bytes data);

  function safeTransfer(address token, address to, uint256 value) internal {
    _callOptionalReturn(token, abi.encodeWithSignature("transfer(address,uint256)", to, value));
  }

  function safeTransferFrom(address token, address from, address to, uint256 value) internal {
    _callOptionalReturn(token, abi.encodeWithSignature("transferFrom(address,address,uint256)", from, to, value));
  }

  function safeApprove(address token, address spender, uint256 value) internal {
    _callOptionalReturn(token, abi.encodeWithSignature("approve(address,uint256)", spender, value));
  }

  function forceApprove(address token, address spender, uint256 value) internal {
    if (value == 0) {
      (bool zeroSuccess, bytes memory zeroResult) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, 0));
      if (!zeroSuccess || (zeroResult.length != 0 && !abi.decode(zeroResult, (bool)))) {
        revert ERC20CallFailed(token, abi.encodeWithSignature("approve(address,uint256)", spender, 0));
      }
      return;
    }

    (bool success, bytes memory result) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, value));
    if (success && (result.length == 0 || abi.decode(result, (bool)))) {
      return;
    }

    safeApprove(token, spender, 0);
    safeApprove(token, spender, value);
  }

  function _callOptionalReturn(address token, bytes memory data) private {
    (bool success, bytes memory result) = token.call(data);
    if (!success || (result.length != 0 && !abi.decode(result, (bool)))) {
      revert ERC20CallFailed(token, data);
    }
  }
}
