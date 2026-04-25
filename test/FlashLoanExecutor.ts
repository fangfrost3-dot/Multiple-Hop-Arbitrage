import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("FlashLoanExecutor", function () {
  it("repays the lender and forwards profit to the recipient", async function () {
    const base = await ethers.deployContract("MockERC20", ["Base", "BASE", 18]);
    const quote = await ethers.deployContract("MockERC20", ["Quote", "QUOTE", 18]);
    const lender = await ethers.deployContract("MockFlashLender", [9]);
    const adapterA = await ethers.deployContract("MockDexAdapter", [11_000]);
    const adapterB = await ethers.deployContract("MockDexAdapter", [10_000]);
    const executor = await ethers.deployContract("FlashLoanExecutor", [await lender.getAddress()]);
    const recipient = ethers.Wallet.createRandom().address;

    await base.mint(await lender.getAddress(), ethers.parseEther("1000000"));
    await quote.mint(await adapterA.getAddress(), ethers.parseEther("1000000"));
    await base.mint(await adapterB.getAddress(), ethers.parseEther("1000000"));

    const plan = {
      profitToken: await base.getAddress(),
      minProfit: ethers.parseEther("5"),
      profitRecipient: recipient,
      swaps: [
        {
          adapter: await adapterA.getAddress(),
          tokenIn: await base.getAddress(),
          tokenOut: await quote.getAddress(),
          routeData: "0x",
        },
        {
          adapter: await adapterB.getAddress(),
          tokenIn: await quote.getAddress(),
          tokenOut: await base.getAddress(),
          routeData: "0x",
        },
      ],
    };

    const abi = ethers.AbiCoder.defaultAbiCoder();
    const encodedPlan = abi.encode(
      [
        "tuple(address profitToken,uint256 minProfit,address profitRecipient,tuple(address adapter,address tokenIn,address tokenOut,bytes routeData)[] swaps)",
      ],
      [plan],
    );

    await executor.requestFlashLoan(await base.getAddress(), ethers.parseEther("100"), encodedPlan);

    expect(await base.balanceOf(recipient)).to.be.gt(ethers.parseEther("5"));
  });
});
