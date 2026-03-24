import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const PENDING = 1;
const CLAIMED = 3;

describe("UnstakeCooldown + SUSDaiCooldownRequestImpl", () => {
  let unstakeCooldown: any;
  let cooldownImpl: any;
  let mockSUSDai: any;
  let mockUSDai: any;
  let owner: SignerWithAddress;
  let authorized: SignerWithAddress;
  let beneficiary: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;

  beforeEach(async () => {
    [owner, authorized, beneficiary, other] = await ethers.getSigners();

    // Deploy USDai
    const BaseFactory = await ethers.getContractFactory("MockBaseAsset");
    mockUSDai = await BaseFactory.deploy("USDai", "USDai");

    // Deploy MockStakedUSDai
    const SUSDaiFactory = await ethers.getContractFactory("MockStakedUSDai");
    mockSUSDai = await SUSDaiFactory.deploy(await mockUSDai.getAddress(), E18);

    // Fund sUSDai vault with USDai for redemptions
    await mockUSDai.mint(await mockSUSDai.getAddress(), 1_000_000n * E18);

    // Deploy UnstakeCooldown
    const UCFactory = await ethers.getContractFactory("UnstakeCooldown");
    unstakeCooldown = await UCFactory.deploy(owner.address);

    // Deploy SUSDaiCooldownRequestImpl
    const ImplFactory = await ethers.getContractFactory("SUSDaiCooldownRequestImpl");
    cooldownImpl = await ImplFactory.deploy(
      await mockSUSDai.getAddress(),
      await mockUSDai.getAddress(),
      await unstakeCooldown.getAddress(),
    );

    // Register impl for sUSDai token
    await unstakeCooldown.connect(owner).setImplementation(
      await mockSUSDai.getAddress(),
      await cooldownImpl.getAddress(),
    );

    // Authorize caller
    await unstakeCooldown.connect(owner).setAuthorized(authorized.address, true);

    // Get sUSDai for authorized: deposit USDai → sUSDai
    await mockUSDai.mint(authorized.address, 100_000n * E18);
    await mockUSDai.connect(authorized).approve(await mockSUSDai.getAddress(), ethers.MaxUint256);
    await mockSUSDai.connect(authorized).deposit(50_000n * E18, authorized.address);

    // Approve UnstakeCooldown to spend authorized's sUSDai
    await mockSUSDai.connect(authorized).approve(await unstakeCooldown.getAddress(), ethers.MaxUint256);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  request — initiateCooldown flow
  // ═══════════════════════════════════════════════════════════════════

  describe("request", () => {
    it("should create PENDING request and delegate to impl", async () => {
      const sAddr = await mockSUSDai.getAddress();
      await unstakeCooldown.connect(authorized).request(beneficiary.address, sAddr, 1000n * E18);

      const req = await unstakeCooldown.getRequest(1);
      expect(req.beneficiary).to.equal(beneficiary.address);
      expect(req.token).to.equal(sAddr);
      expect(req.amount).to.equal(1000n * E18);
      expect(req.status).to.equal(PENDING);
    });

    it("should store cooldownId → redemptionId mapping in impl", async () => {
      const sAddr = await mockSUSDai.getAddress();
      await unstakeCooldown.connect(authorized).request(beneficiary.address, sAddr, 1000n * E18);

      // Impl should have cooldownId=1 → redemptionId=1
      expect(await cooldownImpl.s_cooldownToRedemption(1)).to.equal(1);
    });

    it("should set unlockTime from sUSDai.redemptionTimestamp (not hardcoded)", async () => {
      const sAddr = await mockSUSDai.getAddress();
      await unstakeCooldown.connect(authorized).request(beneficiary.address, sAddr, 1000n * E18);

      const req = await unstakeCooldown.getRequest(1);
      const now = BigInt(await time.latest());
      // Default cooldown = 7 days in MockStakedUSDai
      expect(req.unlockTime).to.be.gte(now + 7n * 86400n - 2n);
      expect(req.unlockTime).to.be.lte(now + 7n * 86400n + 2n);
    });

    it("should reflect changed cooldown from sUSDai protocol", async () => {
      await mockSUSDai.setDefaultCooldown(3 * 86400); // 3 days

      const sAddr = await mockSUSDai.getAddress();
      await unstakeCooldown.connect(authorized).request(beneficiary.address, sAddr, 1000n * E18);

      const req = await unstakeCooldown.getRequest(1);
      const now = BigInt(await time.latest());
      expect(req.unlockTime).to.be.gte(now + 3n * 86400n - 2n);
      expect(req.unlockTime).to.be.lte(now + 3n * 86400n + 2n);
    });

    it("should emit CooldownRequested event", async () => {
      await expect(
        unstakeCooldown.connect(authorized).request(beneficiary.address, await mockSUSDai.getAddress(), 1000n * E18),
      ).to.emit(unstakeCooldown, "CooldownRequested");
    });

    it("should revert for token with no impl registered", async () => {
      await expect(
        unstakeCooldown.connect(authorized).request(beneficiary.address, await mockUSDai.getAddress(), 100n * E18),
      ).to.be.revertedWithCustomError(unstakeCooldown, "PrimeVaults__NoImplForToken");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  claim BEFORE serviceRedemptions → revert
  // ═══════════════════════════════════════════════════════════════════

  describe("claim before serviceRedemptions", () => {
    it("should revert because redemption not yet claimable", async () => {
      await unstakeCooldown.connect(authorized).request(beneficiary.address, await mockSUSDai.getAddress(), 1000n * E18);

      // Advance past unlock time — but serviceRedemptions not called
      await time.increase(8 * 86400);

      await expect(unstakeCooldown.claim(1))
        .to.be.revertedWithCustomError(unstakeCooldown, "PrimeVaults__NotClaimable");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  claim AFTER serviceRedemptions → success
  // ═══════════════════════════════════════════════════════════════════

  describe("claim after serviceRedemptions", () => {
    it("should transfer USDai to beneficiary", async () => {
      await unstakeCooldown.connect(authorized).request(beneficiary.address, await mockSUSDai.getAddress(), 1000n * E18);

      // USD.AI admin services the redemption
      await mockSUSDai.serviceRedemptions(1);

      const out = await unstakeCooldown.claim.staticCall(1);
      expect(out).to.equal(1000n * E18); // 1:1 rate

      await unstakeCooldown.claim(1);
      expect(await mockUSDai.balanceOf(beneficiary.address)).to.equal(1000n * E18);
    });

    it("should set status to CLAIMED", async () => {
      await unstakeCooldown.connect(authorized).request(beneficiary.address, await mockSUSDai.getAddress(), 1000n * E18);
      await mockSUSDai.serviceRedemptions(1);
      await unstakeCooldown.claim(1);

      expect((await unstakeCooldown.getRequest(1)).status).to.equal(CLAIMED);
    });

    it("should emit CooldownClaimed event", async () => {
      await unstakeCooldown.connect(authorized).request(beneficiary.address, await mockSUSDai.getAddress(), 1000n * E18);
      await mockSUSDai.serviceRedemptions(1);

      await expect(unstakeCooldown.claim(1)).to.emit(unstakeCooldown, "CooldownClaimed");
    });

    it("should revert on double claim", async () => {
      await unstakeCooldown.connect(authorized).request(beneficiary.address, await mockSUSDai.getAddress(), 1000n * E18);
      await mockSUSDai.serviceRedemptions(1);
      await unstakeCooldown.claim(1);

      await expect(unstakeCooldown.claim(1))
        .to.be.revertedWithCustomError(unstakeCooldown, "PrimeVaults__AlreadyClaimed");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  isCooldownComplete
  // ═══════════════════════════════════════════════════════════════════

  describe("isCooldownComplete", () => {
    beforeEach(async () => {
      await unstakeCooldown.connect(authorized).request(beneficiary.address, await mockSUSDai.getAddress(), 1000n * E18);
    });

    it("should return false before serviceRedemptions", async () => {
      expect(await unstakeCooldown.isClaimable(1)).to.be.false;
    });

    it("should return true after serviceRedemptions", async () => {
      await mockSUSDai.serviceRedemptions(1);
      expect(await unstakeCooldown.isClaimable(1)).to.be.true;
    });

    it("should return false after claimed", async () => {
      await mockSUSDai.serviceRedemptions(1);
      await unstakeCooldown.claim(1);
      expect(await unstakeCooldown.isClaimable(1)).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Multiple requests — separate redemptionIds
  // ═══════════════════════════════════════════════════════════════════

  describe("multiple requests", () => {
    it("should track separate redemptionIds for each request", async () => {
      const sAddr = await mockSUSDai.getAddress();
      await unstakeCooldown.connect(authorized).request(beneficiary.address, sAddr, 1000n * E18);
      await unstakeCooldown.connect(authorized).request(beneficiary.address, sAddr, 2000n * E18);
      await unstakeCooldown.connect(authorized).request(other.address, sAddr, 500n * E18);

      // Each gets unique cooldownId in impl
      expect(await cooldownImpl.s_cooldownToRedemption(1)).to.equal(1);
      expect(await cooldownImpl.s_cooldownToRedemption(2)).to.equal(2);
      expect(await cooldownImpl.s_cooldownToRedemption(3)).to.equal(3);

      // Service only first — others not claimable
      await mockSUSDai.serviceRedemptions(1);
      expect(await unstakeCooldown.isClaimable(1)).to.be.true;
      expect(await unstakeCooldown.isClaimable(2)).to.be.false;
      expect(await unstakeCooldown.isClaimable(3)).to.be.false;
    });

    it("should return correct pending requests per beneficiary", async () => {
      const sAddr = await mockSUSDai.getAddress();
      await unstakeCooldown.connect(authorized).request(beneficiary.address, sAddr, 1000n * E18);
      await unstakeCooldown.connect(authorized).request(beneficiary.address, sAddr, 2000n * E18);
      await unstakeCooldown.connect(authorized).request(other.address, sAddr, 500n * E18);

      const pending = await unstakeCooldown.getPendingRequests(beneficiary.address);
      expect(pending.length).to.equal(2);
      expect(pending[0]).to.equal(1);
      expect(pending[1]).to.equal(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  redemptionIds on sUSDai
  // ═══════════════════════════════════════════════════════════════════

  describe("redemptionIds tracking", () => {
    it("should have redemptionIds on sUSDai for the impl controller", async () => {
      const sAddr = await mockSUSDai.getAddress();
      await unstakeCooldown.connect(authorized).request(beneficiary.address, sAddr, 1000n * E18);
      await unstakeCooldown.connect(authorized).request(beneficiary.address, sAddr, 2000n * E18);

      const implAddr = await cooldownImpl.getAddress();
      const ids = await mockSUSDai.redemptionIds(implAddr);
      expect(ids.length).to.equal(2);
      expect(ids[0]).to.equal(1);
      expect(ids[1]).to.equal(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Access control
  // ═══════════════════════════════════════════════════════════════════

  describe("access control", () => {
    it("should revert request from non-authorized", async () => {
      await expect(
        unstakeCooldown.connect(other).request(beneficiary.address, await mockSUSDai.getAddress(), 100n * E18),
      ).to.be.revertedWithCustomError(unstakeCooldown, "PrimeVaults__Unauthorized");
    });

    it("should revert impl calls from non-UnstakeCooldown", async () => {
      await expect(cooldownImpl.connect(other).initiateCooldown(100n * E18))
        .to.be.revertedWithCustomError(cooldownImpl, "PrimeVaults__Unauthorized");
    });
  });
});
