import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const PENDING = 1;
const CLAIMED = 3;

describe("SharesCooldown", () => {
  let cooldown: any;
  let mockShares: any;
  let owner: SignerWithAddress;
  let cdoCaller: SignerWithAddress;
  let beneficiary: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;
  const COOLDOWN_DURATION = 7 * 86400; // 7 days

  beforeEach(async () => {
    [owner, cdoCaller, beneficiary, other] = await ethers.getSigners();

    // Mock vault shares token
    const TokenFactory = await ethers.getContractFactory("MockBaseAsset");
    mockShares = await TokenFactory.deploy("pvSENIOR", "pvSR");

    // Deploy SharesCooldown
    const CooldownFactory = await ethers.getContractFactory("SharesCooldown");
    cooldown = await CooldownFactory.deploy(owner.address, COOLDOWN_DURATION);

    // Authorize CDO caller
    await cooldown.connect(owner).setAuthorized(cdoCaller.address, true);

    // Mint shares to CDO caller and approve
    await mockShares.mint(cdoCaller.address, 100_000n * E18);
    await mockShares.connect(cdoCaller).approve(await cooldown.getAddress(), ethers.MaxUint256);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  request — escrows shares
  // ═══════════════════════════════════════════════════════════════════

  describe("request", () => {
    it("should escrow shares from caller (not burn them)", async () => {
      const sharesAddr = await mockShares.getAddress();
      await cooldown.connect(cdoCaller).request(beneficiary.address, sharesAddr, 1000n * E18);

      // Shares held by cooldown contract (escrowed, not burned)
      expect(await mockShares.balanceOf(await cooldown.getAddress())).to.equal(1000n * E18);
      // Caller's balance reduced
      expect(await mockShares.balanceOf(cdoCaller.address)).to.equal(99_000n * E18);
      // Total supply unchanged — shares still exist
      expect(await mockShares.totalSupply()).to.equal(100_000n * E18);
    });

    it("should create PENDING request with correct fields", async () => {
      await cooldown.connect(cdoCaller).request(beneficiary.address, await mockShares.getAddress(), 500n * E18);

      const req = await cooldown.getRequest(1);
      expect(req.beneficiary).to.equal(beneficiary.address);
      expect(req.amount).to.equal(500n * E18);
      expect(req.status).to.equal(PENDING);
    });

    it("should store original caller for return on claim", async () => {
      await cooldown.connect(cdoCaller).request(beneficiary.address, await mockShares.getAddress(), 500n * E18);
      expect(await cooldown.s_requestCaller(1)).to.equal(cdoCaller.address);
    });

    it("should emit CooldownRequested event", async () => {
      await expect(
        cooldown.connect(cdoCaller).request(beneficiary.address, await mockShares.getAddress(), 500n * E18),
      ).to.emit(cooldown, "CooldownRequested");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  claim — returns shares to CALLER (not beneficiary)
  // ═══════════════════════════════════════════════════════════════════

  describe("claim after unlock", () => {
    beforeEach(async () => {
      await cooldown.connect(cdoCaller).request(beneficiary.address, await mockShares.getAddress(), 1000n * E18);
    });

    it("should return shares to original caller (CDO), not beneficiary", async () => {
      await time.increase(COOLDOWN_DURATION);
      await cooldown.claim(1);

      // Shares go back to CDO caller
      expect(await mockShares.balanceOf(cdoCaller.address)).to.equal(100_000n * E18);
      // Beneficiary gets nothing directly (CDO handles conversion)
      expect(await mockShares.balanceOf(beneficiary.address)).to.equal(0);
      // Cooldown contract empty
      expect(await mockShares.balanceOf(await cooldown.getAddress())).to.equal(0);
    });

    it("should set status to CLAIMED", async () => {
      await time.increase(COOLDOWN_DURATION);
      await cooldown.claim(1);
      expect((await cooldown.getRequest(1)).status).to.equal(CLAIMED);
    });

    it("should emit CooldownClaimed event", async () => {
      await time.increase(COOLDOWN_DURATION);
      await expect(cooldown.claim(1)).to.emit(cooldown, "CooldownClaimed");
    });

    it("should preserve total supply (shares not burned during cooldown)", async () => {
      // Before claim: total supply unchanged
      expect(await mockShares.totalSupply()).to.equal(100_000n * E18);

      await time.increase(COOLDOWN_DURATION);
      await cooldown.claim(1);

      // After claim: total supply STILL unchanged (shares returned, not burned)
      expect(await mockShares.totalSupply()).to.equal(100_000n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  claim before unlock → revert
  // ═══════════════════════════════════════════════════════════════════

  describe("claim before unlock", () => {
    it("should revert with CooldownNotReady", async () => {
      await cooldown.connect(cdoCaller).request(beneficiary.address, await mockShares.getAddress(), 1000n * E18);

      await time.increase(COOLDOWN_DURATION / 2);

      await expect(cooldown.claim(1))
        .to.be.revertedWithCustomError(cooldown, "PrimeVaults__CooldownNotReady");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  claim twice → revert
  // ═══════════════════════════════════════════════════════════════════

  describe("claim twice", () => {
    it("should revert with AlreadyClaimed", async () => {
      await cooldown.connect(cdoCaller).request(beneficiary.address, await mockShares.getAddress(), 1000n * E18);
      await time.increase(COOLDOWN_DURATION);
      await cooldown.claim(1);

      await expect(cooldown.claim(1))
        .to.be.revertedWithCustomError(cooldown, "PrimeVaults__AlreadyClaimed");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  No expiry (unlike ERC20Cooldown)
  // ═══════════════════════════════════════════════════════════════════

  describe("no expiry", () => {
    it("should still be claimable long after unlock (no expiry window)", async () => {
      await cooldown.connect(cdoCaller).request(beneficiary.address, await mockShares.getAddress(), 1000n * E18);

      // Advance way past unlock (30 days)
      await time.increase(30 * 86400);

      await expect(cooldown.claim(1)).to.not.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  View functions
  // ═══════════════════════════════════════════════════════════════════

  describe("view functions", () => {
    beforeEach(async () => {
      await cooldown.connect(cdoCaller).request(beneficiary.address, await mockShares.getAddress(), 1000n * E18);
    });

    it("isClaimable: false before unlock, true after", async () => {
      expect(await cooldown.isClaimable(1)).to.be.false;
      await time.increase(COOLDOWN_DURATION);
      expect(await cooldown.isClaimable(1)).to.be.true;
    });

    it("timeRemaining: decreases, then 0", async () => {
      const remaining = await cooldown.timeRemaining(1);
      expect(remaining).to.be.gte(COOLDOWN_DURATION - 2);

      await time.increase(COOLDOWN_DURATION);
      expect(await cooldown.timeRemaining(1)).to.equal(0);
    });

    it("getPendingRequests: returns correct IDs", async () => {
      await cooldown.connect(cdoCaller).request(beneficiary.address, await mockShares.getAddress(), 500n * E18);

      const pending = await cooldown.getPendingRequests(beneficiary.address);
      expect(pending.length).to.equal(2);

      await time.increase(COOLDOWN_DURATION);
      await cooldown.claim(1);

      const pendingAfter = await cooldown.getPendingRequests(beneficiary.address);
      expect(pendingAfter.length).to.equal(1);
      expect(pendingAfter[0]).to.equal(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Access control
  // ═══════════════════════════════════════════════════════════════════

  describe("access control", () => {
    it("should revert request from non-authorized", async () => {
      await expect(
        cooldown.connect(other).request(beneficiary.address, await mockShares.getAddress(), 100n * E18),
      ).to.be.revertedWithCustomError(cooldown, "PrimeVaults__Unauthorized");
    });
  });
});
