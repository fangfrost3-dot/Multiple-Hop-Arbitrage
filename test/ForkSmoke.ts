import { expect } from "chai";
import { network } from "hardhat";

const describeFork = process.env.FORK_RPC_URL ? describe : describe.skip;

describeFork("Fork smoke", function () {
  it("creates a forked l1 network connection and mines a transaction", async function () {
    const { ethers } = await network.create({
      network: "hardhatMainnet",
      chainType: "l1",
    });

    const provider = ethers.provider;
    const [signer] = await ethers.getSigners();
    const startBlock = await provider.getBlockNumber();

    expect(startBlock).to.be.greaterThan(0);

    const tx = await signer.sendTransaction({
      to: signer.address,
      value: 1n,
    });

    const receipt = await tx.wait();
    const endBlock = await provider.getBlockNumber();

    expect(receipt?.status).to.equal(1);
    expect(endBlock).to.be.greaterThanOrEqual(startBlock);
  });
});
