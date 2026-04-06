import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// CooldownStatus enum
const NONE = 0;
const PENDING = 1;
const CLAIMABLE = 2;
const CLAIMED = 3;
const EXPIRED = 4;

describe("ERC20Cooldown", () => {
  let cooldown: any;
  let mockToken: any;
  let owner: SignerWithAddress;
  let authorized: SignerWithAddress;
  let beneficiary: SignerWithAddress;
  let other: SignerWithAddress;

  const E18 = 10n ** 18n;
  const COOLDOWN_DURATION = 7 * 86400; // 7 days
  const EXPIRY_WINDOW = 3 * 86400;     // 3 days after unlock

  beforeEach(async () => {
    [owner, authorized, beneficiary, other] = await ethers.getSigners();

    // Deploy mock token
    const TokenFactory = await ethers.getContractFactory("MockBaseAsset");
    mockToken = await TokenFactory.deploy("TestToken", "TT");

    // Deploy ERC20Cooldown
    const CooldownFactory = await ethers.getContractFactory("ERC20Cooldown");
    cooldown = await CooldownFactory.deploy(owner.address);

    // Authorize caller
    await cooldown.connect(owner).setAuthorized(authorized.address, true);

    // Fund authorized with tokens and approve
    await mockToken.mint(authorized.address, 100_000n * E18);
    await mockToken.connect(authorized).approve(await cooldown.getAddress(), ethers.MaxUint256);
  });

  // ═══════════════════════════════════════════════════════════════════
  //  request
  // ═══════════════════════════════════════════════════════════════════

  describe("request", () => {
    it("should create PENDING request and lock tokens", async () => {
      const tokenAddr = await mockToken.getAddress();
      await cooldown.connect(authorized).request(beneficiary.address, tokenAddr, 1000n * E18, COOLDOWN_DURATION);

      // Tokens locked in cooldown contract
      expect(await mockToken.balanceOf(await cooldown.getAddress())).to.equal(1000n * E18);

      // Request created
      const req = await cooldown.getRequest(1);
      expect(req.beneficiary).to.equal(beneficiary.address);
      expect(req.token).to.equal(tokenAddr);
      expect(req.amount).to.equal(1000n * E18);
      expect(req.status).to.equal(PENDING);
    });

    it("should set correct unlockTime and expiryTime", async () => {
      await cooldown.connect(authorized).request(beneficiary.address, await mockToken.getAddress(), 100n * E18, COOLDOWN_DURATION);

      const req = await cooldown.getRequest(1);
      const now = BigInt(await time.latest());
      expect(req.unlockTime).to.be.gte(now + BigInt(COOLDOWN_DURATION));
      expect(req.expiryTime).to.equal(req.unlockTime + BigInt(EXPIRY_WINDOW));
    });

    it("should increment request IDs globally", async () => {
      const tokenAddr = await mockToken.getAddress();
      await cooldown.connect(authorized).request(beneficiary.address, tokenAddr, 100n * E18, COOLDOWN_DURATION);
      await cooldown.connect(authorized).request(other.address, tokenAddr, 200n * E18, COOLDOWN_DURATION);

      expect((await cooldown.getRequest(1)).amount).to.equal(100n * E18);
      expect((await cooldown.getRequest(2)).amount).to.equal(200n * E18);
      expect((await cooldown.getRequest(2)).beneficiary).to.equal(other.address);
    });

    it("should emit CooldownRequested event", async () => {
      await expect(
        cooldown.connect(authorized).request(beneficiary.address, await mockToken.getAddress(), 500n * E18, COOLDOWN_DURATION),
      ).to.emit(cooldown, "CooldownRequested");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  claim — after unlockTime
  // ═══════════════════════════════════════════════════════════════════

  describe("claim after unlockTime", () => {
    beforeEach(async () => {
      await cooldown.connect(authorized).request(beneficiary.address, await mockToken.getAddress(), 1000n * E18, COOLDOWN_DURATION);
    });

    it("should transfer tokens to beneficiary", async () => {
      await time.increase(COOLDOWN_DURATION);

      await cooldown.claim(1);

      expect(await mockToken.balanceOf(beneficiary.address)).to.equal(1000n * E18);
      expect(await mockToken.balanceOf(await cooldown.getAddress())).to.equal(0);
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

    it("should return correct amountOut", async () => {
      await time.increase(COOLDOWN_DURATION);
      const out = await cooldown.claim.staticCall(1);
      expect(out).to.equal(1000n * E18);
    });

    it("should allow anyone to claim (not just beneficiary)", async () => {
      await time.increase(COOLDOWN_DURATION);
      await expect(cooldown.connect(other).claim(1)).to.not.be.reverted;
      // Tokens go to beneficiary, not caller
      expect(await mockToken.balanceOf(beneficiary.address)).to.equal(1000n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  claim — before unlockTime → revert
  // ═══════════════════════════════════════════════════════════════════

  describe("claim before unlockTime", () => {
    it("should revert with CooldownNotReady", async () => {
      await cooldown.connect(authorized).request(beneficiary.address, await mockToken.getAddress(), 1000n * E18, COOLDOWN_DURATION);

      // Only advance halfway
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
      await cooldown.connect(authorized).request(beneficiary.address, await mockToken.getAddress(), 1000n * E18, COOLDOWN_DURATION);
      await time.increase(COOLDOWN_DURATION);
      await cooldown.claim(1);

      await expect(cooldown.claim(1))
        .to.be.revertedWithCustomError(cooldown, "PrimeVaults__AlreadyClaimed");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  expired request → revert
  // ═══════════════════════════════════════════════════════════════════

  describe("expired request", () => {
    it("should revert with Expired when past expiryTime", async () => {
      await cooldown.connect(authorized).request(beneficiary.address, await mockToken.getAddress(), 1000n * E18, COOLDOWN_DURATION);

      // Advance well past unlock + expiry
      await time.increase(COOLDOWN_DURATION + EXPIRY_WINDOW + 100);

      await expect(cooldown.claim(1))
        .to.be.revertedWithCustomError(cooldown, "PrimeVaults__Expired");
    });

    it("should succeed when claimed within expiry window", async () => {
      await cooldown.connect(authorized).request(beneficiary.address, await mockToken.getAddress(), 1000n * E18, COOLDOWN_DURATION);

      // Advance to middle of expiry window (after unlock but before expiry)
      await time.increase(COOLDOWN_DURATION + EXPIRY_WINDOW / 2);

      await expect(cooldown.claim(1)).to.not.be.reverted;
      expect(await mockToken.balanceOf(beneficiary.address)).to.equal(1000n * E18);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  getPendingRequests
  // ═══════════════════════════════════════════════════════════════════

  describe("getPendingRequests", () => {
    it("should return correct pending IDs", async () => {
      const tokenAddr = await mockToken.getAddress();
      await cooldown.connect(authorized).request(beneficiary.address, tokenAddr, 100n * E18, COOLDOWN_DURATION);
      await cooldown.connect(authorized).request(beneficiary.address, tokenAddr, 200n * E18, COOLDOWN_DURATION);
      await cooldown.connect(authorized).request(beneficiary.address, tokenAddr, 300n * E18, COOLDOWN_DURATION);

      const pending = await cooldown.getPendingRequests(beneficiary.address);
      expect(pending.length).to.equal(3);
      expect(pending[0]).to.equal(1);
      expect(pending[1]).to.equal(2);
      expect(pending[2]).to.equal(3);
    });

    it("should exclude claimed requests", async () => {
      const tokenAddr = await mockToken.getAddress();
      await cooldown.connect(authorized).request(beneficiary.address, tokenAddr, 100n * E18, COOLDOWN_DURATION);
      await cooldown.connect(authorized).request(beneficiary.address, tokenAddr, 200n * E18, COOLDOWN_DURATION);

      await time.increase(COOLDOWN_DURATION);
      await cooldown.claim(1); // claim first

      const pending = await cooldown.getPendingRequests(beneficiary.address);
      expect(pending.length).to.equal(1);
      expect(pending[0]).to.equal(2);
    });

    it("should return empty for address with no requests", async () => {
      const pending = await cooldown.getPendingRequests(other.address);
      expect(pending.length).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  isClaimable
  // ═══════════════════════════════════════════════════════════════════

  describe("isClaimable", () => {
    beforeEach(async () => {
      await cooldown.connect(authorized).request(beneficiary.address, await mockToken.getAddress(), 1000n * E18, COOLDOWN_DURATION);
    });

    it("should return false before unlockTime", async () => {
      expect(await cooldown.isClaimable(1)).to.be.false;
    });

    it("should return true after unlockTime and before expiry", async () => {
      await time.increase(COOLDOWN_DURATION);
      expect(await cooldown.isClaimable(1)).to.be.true;
    });

    it("should return false after expiryTime", async () => {
      await time.increase(COOLDOWN_DURATION + EXPIRY_WINDOW + 1);
      expect(await cooldown.isClaimable(1)).to.be.false;
    });

    it("should return false after claimed", async () => {
      await time.increase(COOLDOWN_DURATION);
      await cooldown.claim(1);
      expect(await cooldown.isClaimable(1)).to.be.false;
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  timeRemaining
  // ═══════════════════════════════════════════════════════════════════

  describe("timeRemaining", () => {
    it("should return full duration right after request", async () => {
      await cooldown.connect(authorized).request(beneficiary.address, await mockToken.getAddress(), 100n * E18, COOLDOWN_DURATION);
      const remaining = await cooldown.timeRemaining(1);
      // Should be close to COOLDOWN_DURATION (allow ±2 for block time)
      expect(remaining).to.be.gte(COOLDOWN_DURATION - 2);
      expect(remaining).to.be.lte(COOLDOWN_DURATION);
    });

    it("should decrease over time", async () => {
      await cooldown.connect(authorized).request(beneficiary.address, await mockToken.getAddress(), 100n * E18, COOLDOWN_DURATION);

      await time.increase(86400); // 1 day
      const remaining = await cooldown.timeRemaining(1);
      expect(remaining).to.be.lte(COOLDOWN_DURATION - 86400 + 2);
      expect(remaining).to.be.gte(COOLDOWN_DURATION - 86400 - 2);
    });

    it("should return 0 after unlockTime", async () => {
      await cooldown.connect(authorized).request(beneficiary.address, await mockToken.getAddress(), 100n * E18, COOLDOWN_DURATION);
      await time.increase(COOLDOWN_DURATION);
      expect(await cooldown.timeRemaining(1)).to.equal(0);
    });

    it("should return 0 after claimed", async () => {
      await cooldown.connect(authorized).request(beneficiary.address, await mockToken.getAddress(), 100n * E18, COOLDOWN_DURATION);
      await time.increase(COOLDOWN_DURATION);
      await cooldown.claim(1);
      expect(await cooldown.timeRemaining(1)).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Access control — onlyAuthorized
  // ═══════════════════════════════════════════════════════════════════

  describe("access control", () => {
    it("should revert request from non-authorized caller", async () => {
      await expect(
        cooldown.connect(other).request(beneficiary.address, await mockToken.getAddress(), 100n * E18, COOLDOWN_DURATION),
      ).to.be.revertedWithCustomError(cooldown, "PrimeVaults__Unauthorized");
    });

    it("should allow after authorization", async () => {
      await cooldown.connect(owner).setAuthorized(other.address, true);
      await mockToken.mint(other.address, 1000n * E18);
      await mockToken.connect(other).approve(await cooldown.getAddress(), ethers.MaxUint256);

      await expect(
        cooldown.connect(other).request(beneficiary.address, await mockToken.getAddress(), 100n * E18, COOLDOWN_DURATION),
      ).to.not.be.reverted;
    });

    it("should block after deauthorization", async () => {
      await cooldown.connect(owner).setAuthorized(authorized.address, false);

      await expect(
        cooldown.connect(authorized).request(beneficiary.address, await mockToken.getAddress(), 100n * E18, COOLDOWN_DURATION),
      ).to.be.revertedWithCustomError(cooldown, "PrimeVaults__Unauthorized");
    });
  });
});
