// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — TrancheVault
//  Generic ERC-4626 vault. Same bytecode deployed 3× per market.
//  See: docs/PV_V3_FINAL_v34.md section 19
// ══════════════════════════════════════════════════════════════════════

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IPrimeCDO, TrancheId, CDOWithdrawResult } from "../interfaces/IPrimeCDO.sol";
import { IAccounting } from "../interfaces/IAccounting.sol";

/**
 * @title TrancheVault
 * @notice Generic ERC-4626 vault for a single tranche (Senior, Mezzanine, or Junior).
 * @dev Same bytecode deployed 3× per market. Junior mode detected via i_trancheId == JUNIOR.
 *      totalAssets() reads from Accounting (not token balance).
 *      Deposits route through PrimeCDO. Standard withdraw/redeem disabled — use requestWithdraw.
 *      See MATH_REFERENCE §A1-A3 for share price invariants.
 */
contract TrancheVault is ERC4626 {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    IPrimeCDO public immutable i_cdo;
    TrancheId public immutable i_trancheId;
    IERC20 public immutable i_weth;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event WithdrawRequested(
        address indexed owner,
        address indexed receiver,
        uint256 shares,
        uint256 baseAmount,
        CDOWithdrawResult result
    );
    event JuniorDeposited(
        address indexed caller,
        address indexed receiver,
        uint256 baseAmount,
        uint256 wethAmount,
        uint256 shares
    );

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__NotJunior();
    error PrimeVaults__IsJunior();
    error PrimeVaults__UseRequestWithdraw();
    error PrimeVaults__ZeroShares();

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @param cdo_ Address of the paired PrimeCDO
     * @param trancheId_ Tranche this vault represents (SENIOR, MEZZ, or JUNIOR)
     * @param asset_ Base asset token (e.g., USDai)
     * @param weth_ WETH token address (only used for Junior deposits)
     * @param name_ Vault share token name (e.g., "PrimeVaults Senior")
     * @param symbol_ Vault share token symbol (e.g., "pvSENIOR")
     */
    constructor(
        address cdo_,
        TrancheId trancheId_,
        address asset_,
        address weth_,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) ERC4626(IERC20(asset_)) {
        i_cdo = IPrimeCDO(cdo_);
        i_trancheId = trancheId_;
        i_weth = IERC20(weth_);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ERC-4626 OVERRIDES — totalAssets
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Total assets for this tranche, read from Accounting.
     * @dev See MATH_REFERENCE §A1. Not based on token balance — Accounting is the source of truth.
     */
    function totalAssets() public view override returns (uint256) {
        return IAccounting(i_cdo.accounting()).getTrancheTVL(i_trancheId);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ERC-4626 OVERRIDES — deposit (Senior / Mezzanine)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit base asset into Senior or Mezzanine tranche.
     * @dev Junior must use depositJunior(). Overrides ERC4626.deposit to route through CDO.
     *      Share price invariant: sharePrice_before == sharePrice_after (see MATH_REFERENCE §A2).
     */
    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        if (i_trancheId == TrancheId.JUNIOR) revert PrimeVaults__IsJunior();

        uint256 shares = previewDeposit(assets);

        // 1. Pull base asset from depositor to vault
        SafeERC20.safeTransferFrom(IERC20(asset()), _msgSender(), address(this), assets);

        // 2. Approve CDO and route deposit
        IERC20(asset()).forceApprove(address(i_cdo), assets);
        i_cdo.deposit(i_trancheId, asset(), assets);

        // 3. Mint shares
        _mint(receiver, shares);

        emit Deposit(_msgSender(), receiver, assets, shares);
        return shares;
    }

    /**
     * @notice Mint exact shares by depositing the required base assets.
     * @dev Junior must use depositJunior().
     */
    function mint(uint256 shares, address receiver) public override returns (uint256) {
        if (i_trancheId == TrancheId.JUNIOR) revert PrimeVaults__IsJunior();

        uint256 assets = previewMint(shares);

        SafeERC20.safeTransferFrom(IERC20(asset()), _msgSender(), address(this), assets);
        IERC20(asset()).forceApprove(address(i_cdo), assets);
        i_cdo.deposit(i_trancheId, asset(), assets);

        _mint(receiver, shares);

        emit Deposit(_msgSender(), receiver, assets, shares);
        return assets;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  DEPOSIT — Junior (dual-asset: base + WETH)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit dual-asset (base + WETH) into Junior tranche.
     * @dev Only callable on Junior vault. Routes through CDO.depositJunior.
     *      Shares computed from totalBaseValue (base + WETH USD) at pre-deposit exchange rate.
     * @param baseAmount Amount of base asset to deposit
     * @param wethAmount Amount of WETH to deposit
     * @param receiver Address to receive vault shares
     * @return shares Vault shares minted
     */
    function depositJunior(uint256 baseAmount, uint256 wethAmount, address receiver) external returns (uint256 shares) {
        if (i_trancheId != TrancheId.JUNIOR) revert PrimeVaults__NotJunior();

        // 1. Snapshot for share calculation (before CDO modifies accounting)
        uint256 assetsBefore = totalAssets();
        uint256 supplyBefore = totalSupply();

        // 2. Pull tokens from depositor to vault
        if (baseAmount > 0) {
            SafeERC20.safeTransferFrom(IERC20(asset()), _msgSender(), address(this), baseAmount);
        }
        if (wethAmount > 0) {
            i_weth.safeTransferFrom(_msgSender(), address(this), wethAmount);
        }

        // 3. Approve CDO for both tokens
        if (baseAmount > 0) IERC20(asset()).forceApprove(address(i_cdo), baseAmount);
        if (wethAmount > 0) i_weth.forceApprove(address(i_cdo), wethAmount);

        // 4. Route to CDO — returns total base-equivalent value
        uint256 totalBaseValue = i_cdo.depositJunior(asset(), baseAmount, wethAmount, _msgSender());

        // 5. Compute shares from pre-deposit snapshot (see MATH_REFERENCE §A2)
        if (supplyBefore == 0) shares = totalBaseValue;
        else shares = totalBaseValue.mulDiv(supplyBefore, assetsBefore, Math.Rounding.Floor);

        // 6. Mint shares
        _mint(receiver, shares);

        emit JuniorDeposited(_msgSender(), receiver, baseAmount, wethAmount, shares);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ERC-4626 OVERRIDES — withdraw/redeem DISABLED
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Standard ERC-4626 withdraw disabled. Use requestWithdraw() instead.
     *      Withdrawals may involve cooldown periods incompatible with sync ERC-4626.
     */
    function withdraw(uint256, address, address) public pure override returns (uint256) {
        revert PrimeVaults__UseRequestWithdraw();
    }

    /**
     * @dev Standard ERC-4626 redeem disabled. Use requestWithdraw() instead.
     */
    function redeem(uint256, address, address) public pure override returns (uint256) {
        revert PrimeVaults__UseRequestWithdraw();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  WITHDRAW — requestWithdraw (all tranches)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Request withdrawal by redeeming vault shares.
     * @dev Burns shares for NONE/ASSETS_LOCK mechanisms. Escrows shares for SHARES_LOCK.
     *      Senior/Mezz: routes to CDO.requestWithdraw.
     *      Junior: routes to CDO.withdrawJunior (proportional base + WETH).
     * @param shares Number of vault shares to redeem
     * @param outputToken Desired output token
     * @param receiver Address to receive withdrawn tokens
     * @return result CDO withdrawal result with mechanism details
     */
    function requestWithdraw(
        uint256 shares,
        address outputToken,
        address receiver
    ) external returns (CDOWithdrawResult memory result) {
        if (shares == 0) revert PrimeVaults__ZeroShares();

        address owner = _msgSender();
        uint256 baseAmount = convertToAssets(shares);

        // Transfer shares from owner to vault (for CDO to potentially pull in SharesLock)
        _transfer(owner, address(this), shares);
        _approve(address(this), address(i_cdo), shares);

        if (i_trancheId == TrancheId.JUNIOR) {
            result = i_cdo.withdrawJunior(baseAmount, outputToken, receiver, shares, totalSupply());
        } else {
            result = i_cdo.requestWithdraw(i_trancheId, baseAmount, outputToken, receiver, shares);
        }

        // SHARES_LOCK (type 3): CDO already pulled shares for escrow — do NOT burn
        // All other types: CDO did not pull shares — burn them
        if (result.appliedCooldownType != 3) {
            _burn(address(this), shares);
        }

        emit WithdrawRequested(owner, receiver, shares, baseAmount, result);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CLAIM — pass-through to CDO
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Claim a completed ERC20Cooldown (ASSETS_LOCK) or UnstakeCooldown withdrawal.
     * @dev Delegates to CDO.claimWithdraw. Callable by anyone.
     * @param cooldownId The cooldown request ID
     * @param cooldownHandler Address of the cooldown handler
     * @return amountOut Tokens transferred to beneficiary
     */
    function claimWithdraw(uint256 cooldownId, address cooldownHandler) external returns (uint256 amountOut) {
        return i_cdo.claimWithdraw(cooldownId, cooldownHandler);
    }

    /**
     * @notice Claim a completed SharesCooldown (SHARES_LOCK) withdrawal.
     * @dev Delegates to CDO.claimSharesWithdraw. Callable by anyone.
     * @param cooldownId The SharesCooldown request ID
     * @param outputToken Desired output token
     * @return amountOut Tokens transferred to beneficiary
     */
    function claimSharesWithdraw(uint256 cooldownId, address outputToken) external returns (uint256 amountOut) {
        return i_cdo.claimSharesWithdraw(cooldownId, outputToken);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW — maxDeposit / maxWithdraw overrides
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Returns 0 for withdraw/redeem since standard ERC-4626 path is disabled.
     */
    function maxWithdraw(address) public pure override returns (uint256) {
        return 0;
    }

    /**
     * @dev Returns 0 for redeem since standard ERC-4626 path is disabled.
     */
    function maxRedeem(address) public pure override returns (uint256) {
        return 0;
    }
}
