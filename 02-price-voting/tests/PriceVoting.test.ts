import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

const { viem, networkHelpers } = await network.connect();

const ONE_DAY = 60 * 60 * 24;

describe("PriceVoting", function () {
  async function deployVotingFixture() {
    const [deployer, alice, bob, carol] = await viem.getWalletClients();

    const token = await viem.deployContract("Token", [
      "Vote Token",
      "VOTE",
      parseEther("1000000"),
    ]);

    const now = await networkHelpers.time.latest();
    const votingEnd = BigInt(now + ONE_DAY);

    const voting = await viem.deployContract("PriceVoting", [
      token.address,
      votingEnd,
    ]);

    for (const w of [alice, bob, carol]) {
      await token.write.transfer([w.account.address, parseEther("1000")], {
        account: deployer.account,
      });
      await token.write.approve([voting.address, parseEther("1000")], {
        account: w.account,
      });
    }

    return { deployer, alice, bob, carol, token, voting, votingEnd };
  }

  describe("vote", function () {
    it("records a single vote", async function () {
      const { voting, alice } =
        await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], {
        account: alice.account,
      });

      const weight = await voting.read.weightOf([100n]);
      const locked = await voting.read.lockedOf([alice.account.address]);

      assert.equal(weight, parseEther("50"));
      assert.equal(locked, parseEther("50"));
    });

    it("emits Voted", async function () {
      const { voting, alice } =
        await networkHelpers.loadFixture(deployVotingFixture);

      await viem.assertions.emitWithArgs(
        voting.write.vote([100n, parseEther("50")], {
          account: alice.account,
        }),
        voting,
        "Voted",
        [getAddress(alice.account.address), 100n, parseEther("50")]
      );
    });
  });
});