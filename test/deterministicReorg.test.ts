import { network } from "hardhat";
import { expect } from "chai";

describe("Deterministic reorg simulation", function () {
  it("takes a snapshot, advances blocks, and reverts to simulate a reorg", async function () {
    // create the same forked network used by ForkSmoke so ethers.provider exists
    const created = await network.create({ network: "hardhatArbitrum" });
    const { ethers } = created;
    const provider = ethers.provider;

    const start = await provider.getBlockNumber();

    const snap = await provider.send("evm_snapshot", []);

    // advance a few blocks to simulate work on a fork
    await provider.send("evm_mine", []);
    await provider.send("evm_mine", []);

    // revert to snapshot to simulate reorg
    const reverted = await provider.send("evm_revert", [snap]);
    expect(reverted).to.be.true;

    const end = await provider.getBlockNumber();
    expect(end).to.equal(start);
  });
});
