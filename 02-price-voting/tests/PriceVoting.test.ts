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
    it("records a single vote and updates leader", async function () {
      const { voting, alice } =
        await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], {
        account: alice.account,
      });

      assert.equal(await voting.read.weightOf([100n]), parseEther("50"));
      assert.equal(
        await voting.read.lockedOf([alice.account.address]),
        parseEther("50")
      );
      assert.equal(await voting.read.leaderPrice(), 100n);
      assert.equal(await voting.read.highestWeight(), parseEther("50"));
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

    it("accumulates weights and updates leader when exceeded", async function () {
      const { voting, alice, bob } =
        await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("50")], {
        account: alice.account,
      });
      await voting.write.vote([100n, parseEther("30")], {
        account: alice.account,
      });
      assert.equal(await voting.read.weightOf([100n]), parseEther("80"));
      assert.equal(
        await voting.read.lockedOf([alice.account.address]),
        parseEther("80")
      );
      assert.equal(await voting.read.leaderPrice(), 100n);

      await voting.write.vote([200n, parseEther("100")], {
        account: bob.account,
      });
      assert.equal(await voting.read.leaderPrice(), 200n);
      assert.equal(await voting.read.highestWeight(), parseEther("100"));
    });

    it("does not update leader on a tie", async function () {
      const { voting, alice, bob } =
        await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("75")], {
        account: alice.account,
      });
      await voting.write.vote([200n, parseEther("75")], {
        account: bob.account,
      });

      assert.equal(await voting.read.leaderPrice(), 100n);
      assert.equal(await voting.read.highestWeight(), parseEther("75"));
    });

    it("rejects zero amount and votes at or after votingEnd", async function () {
      const { voting, alice, votingEnd } =
        await networkHelpers.loadFixture(deployVotingFixture);

      await assert.rejects(
        voting.write.vote([100n, 0n], { account: alice.account })
      );

      await networkHelpers.time.increaseTo(votingEnd);
      await assert.rejects(
        voting.write.vote([100n, parseEther("10")], { account: alice.account })
      );
    });
  });

  describe("finalize", function () {
    it("rejects finalizing before votingEnd", async function () {
      const { voting } = await networkHelpers.loadFixture(deployVotingFixture);

      await assert.rejects(voting.write.finalize());
    });

    it("applies leader price once after votingEnd", async function () {
      const { voting, alice, bob, votingEnd } =
        await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([150n, parseEther("60")], {
        account: alice.account,
      });
      await voting.write.vote([250n, parseEther("90")], {
        account: bob.account,
      });

      await networkHelpers.time.increaseTo(votingEnd);

      await viem.assertions.emitWithArgs(
        voting.write.finalize(),
        voting,
        "PriceFinalized",
        [250n, parseEther("90")]
      );

      assert.equal(await voting.read.currentTokenPrice(), 250n);
      assert.equal(await voting.read.finalized(), true);

      await assert.rejects(voting.write.finalize());
    });

    it("leaves currentTokenPrice at 0 on empty voting or tie", async function () {
      const { voting: emptyVoting, votingEnd: emptyEnd } =
        await networkHelpers.loadFixture(deployVotingFixture);
      await networkHelpers.time.increaseTo(emptyEnd);
      await emptyVoting.write.finalize();
      assert.equal(await emptyVoting.read.currentTokenPrice(), 0n);

      const { voting: tiedVoting, alice, bob, votingEnd: tiedEnd } =
        await networkHelpers.loadFixture(deployVotingFixture);
      await tiedVoting.write.vote([100n, parseEther("50")], {
        account: alice.account,
      });
      await tiedVoting.write.vote([200n, parseEther("50")], {
        account: bob.account,
      });
      await networkHelpers.time.increaseTo(tiedEnd);
      await tiedVoting.write.finalize();
      assert.equal(await tiedVoting.read.currentTokenPrice(), 0n);
    });
  });

  describe("claim", function () {
    it("rejects claiming before votingEnd or with nothing to claim", async function () {
      const { voting, alice, bob, votingEnd } =
        await networkHelpers.loadFixture(deployVotingFixture);

      await voting.write.vote([100n, parseEther("40")], {
        account: alice.account,
      });

      await viem.assertions.revertWithCustomError(
        voting.write.claim({ account: alice.account }),
        voting,
        "VotingActive"
      );

      await networkHelpers.time.increaseTo(votingEnd);

      await viem.assertions.revertWithCustomError(
        voting.write.claim({ account: bob.account }),
        voting,
        "NothingToClaim"
      );
    });

    it("returns locked tokens, resets balance, and emits Claimed", async function () {
      const { voting, token, alice, votingEnd } =
        await networkHelpers.loadFixture(deployVotingFixture);

      const balanceBeforeVote = await token.read.balanceOf([
        alice.account.address,
      ]);

      await voting.write.vote([100n, parseEther("120")], {
        account: alice.account,
      });
      assert.equal(
        await voting.read.lockedOf([alice.account.address]),
        parseEther("120")
      );

      await networkHelpers.time.increaseTo(votingEnd);

      await viem.assertions.emitWithArgs(
        voting.write.claim({ account: alice.account }),
        voting,
        "Claimed",
        [getAddress(alice.account.address), parseEther("120")]
      );

      assert.equal(await voting.read.lockedOf([alice.account.address]), 0n);
      assert.equal(
        await token.read.balanceOf([alice.account.address]),
        balanceBeforeVote
      );
      await assert.rejects(voting.write.claim({ account: alice.account }));
    });
  });
});