// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — PrimeCDO
//  Core orchestrator for a PrimeVaults market (1 CDO = 1 Strategy)
//  See: docs/PV_V3_FINAL_v34.md section 18
// ══════════════════════════════════════════════════════════════════════

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IPrimeCDO, TrancheId, CDOWithdrawResult } from "../interfaces/IPrimeCDO.sol";
import { IAccounting } from "../interfaces/IAccounting.sol";
import { IStrategy, WithdrawResult, WithdrawType } from "../interfaces/IStrategy.sol";
import { IAaveWETHAdapter } from "../interfaces/IAaveWETHAdapter.sol";
import { IWETHPriceOracle } from "../interfaces/IWETHPriceOracle.sol";
import { ISwapFacility } from "../interfaces/ISwapFacility.sol";
import { IRatioController } from "../interfaces/IRatioController.sol";
import { ICooldownHandler, CooldownRequest } from "../interfaces/ICooldownHandler.sol";
import { RedemptionPolicy } from "../cooldown/RedemptionPolicy.sol";

/**
 * @title PrimeCDO
 * @notice Core orchestrator connecting TrancheVaults to a single Strategy via Accounting.
 * @dev Handles deposit routing, coverage gates, Junior dual-asset management.
 *      1 CDO = 1 Strategy (Strata model). No StrategyRegistry.
 *      See docs/PV_V3_COVERAGE_GATE.md for coverage gate logic.
 *      See docs/PV_V3_FINAL_v34.md section 11 for WETH ratio hook.
 */
contract PrimeCDO is Ownable2Step, IPrimeCDO {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 public constant PRECISION = 1e18;

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    IAccounting public immutable i_accounting;
    IStrategy public immutable i_strategy;
    IAaveWETHAdapter public immutable i_aaveWETHAdapter;
    IWETHPriceOracle public immutable i_wethOracle;
    ISwapFacility public immutable i_swapFacility;
    address public immutable i_weth;
    RedemptionPolicy public immutable i_redemptionPolicy;
    ICooldownHandler public immutable i_erc20Cooldown;
    ICooldownHandler public immutable i_sharesCooldown;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE — Tranches
    // ═══════════════════════════════════════════════════════════════════

    mapping(TrancheId => address) public s_tranches;
    mapping(address => TrancheId) public s_vaultToTranche;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE — WETH Ratio (fixed 8:2, with upgrade hook)
    // ═══════════════════════════════════════════════════════════════════

    uint256 public s_ratioTarget; // 0.20e18 = 20%
    uint256 public s_ratioTolerance; // 0.02e18 = ±2%
    address public s_ratioController; // address(0) at launch

    // ═══════════════════════════════════════════════════════════════════
    //  STATE — Coverage Gate
    // ═══════════════════════════════════════════════════════════════════

    uint256 public s_minCoverageForDeposit; // 1.05e18
    uint256 public s_juniorShortfallPausePrice; // 0.90e18
    bool public s_shortfallPaused;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event ShortfallPauseTriggered(uint256 pricePerShare, uint256 threshold);
    event ShortfallUnpaused();
    event TrancheRegistered(TrancheId indexed tranche, address vault);
    event WETHCoverageExecuted(uint256 lossUSD, uint256 wethSold, uint256 baseRecovered);
    event RebalanceSellExecuted(uint256 wethSold, uint256 baseReceived, uint256 newRatio);
    event RebalanceBuyExecuted(uint256 baseRecalled, uint256 wethReceived, uint256 newRatio);

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__Unauthorized(address caller);
    error PrimeVaults__ShortfallPaused();
    error PrimeVaults__CoverageTooLow(uint256 current, uint256 minimum);
    error PrimeVaults__RatioOutOfBounds(uint256 actual, uint256 target, uint256 tolerance);
    error PrimeVaults__RatioWithinBounds(uint256 currentRatio);
    error PrimeVaults__ZeroAmount();
    error PrimeVaults__ExceedsMaxRecall(uint256 requested, uint256 max);

    // ═══════════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyTranche(TrancheId id) {
        if (msg.sender != s_tranches[id]) revert PrimeVaults__Unauthorized(msg.sender);
        _;
    }

    modifier whenNotShortfallPaused() {
        if (s_shortfallPaused) revert PrimeVaults__ShortfallPaused();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(
        address accounting_,
        address strategy_,
        address aaveWETHAdapter_,
        address wethOracle_,
        address swapFacility_,
        address weth_,
        address redemptionPolicy_,
        address erc20Cooldown_,
        address sharesCooldown_,
        address owner_
    ) Ownable(owner_) {
        i_accounting = IAccounting(accounting_);
        i_strategy = IStrategy(strategy_);
        i_aaveWETHAdapter = IAaveWETHAdapter(aaveWETHAdapter_);
        i_wethOracle = IWETHPriceOracle(wethOracle_);
        i_swapFacility = ISwapFacility(swapFacility_);
        i_weth = weth_;
        i_redemptionPolicy = RedemptionPolicy(redemptionPolicy_);
        i_erc20Cooldown = ICooldownHandler(erc20Cooldown_);
        i_sharesCooldown = ICooldownHandler(sharesCooldown_);

        // Defaults
        s_ratioTarget = 0.20e18; //20%
        s_ratioTolerance = 0.02e18; //+-2%
        s_minCoverageForDeposit = 1.05e18; // 105%
        s_juniorShortfallPausePrice = 0.90e18; // 90%
    }

    // ═══════════════════════════════════════════════════════════════════
    //  DEPOSIT — Senior / Mezzanine
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit base asset into a Senior or Mezzanine tranche.
     * @dev Coverage gate: reverts if coverage < 105% for Sr/Mz.
     *      See docs/PV_V3_COVERAGE_GATE.md section 3.
     */
    function deposit(
        TrancheId tranche,
        address token,
        uint256 amount
    ) external override onlyTranche(tranche) whenNotShortfallPaused returns (uint256 baseAmount) {
        if (amount == 0) revert PrimeVaults__ZeroAmount();

        // 1. Update accounting
        _updateAccounting();

        // 2. Per-tranche coverage gate
        uint256 coverage;
        if (tranche == TrancheId.SENIOR) coverage = _getCoverageSenior();
        else coverage = _getCoverageMezz();

        if (coverage < s_minCoverageForDeposit) revert PrimeVaults__CoverageTooLow(coverage, s_minCoverageForDeposit);

        // 3. Route tokens directly to strategy
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(token).forceApprove(address(i_strategy), amount);
        i_strategy.depositToken(token, amount);

        // 4. Record deposit (base asset deposits are 1:1 in base-equivalent)
        baseAmount = amount;
        i_accounting.recordDeposit(tranche, baseAmount);

        // 5. Check junior shortfall
        _checkJuniorShortfall();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  DEPOSIT — Junior (dual-asset: base + WETH)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit dual-asset (base + WETH) into Junior tranche.
     * @dev Junior deposits ALWAYS allowed (increases coverage = good).
     *      Validates WETH ratio within [target - tolerance, target + tolerance].
     *      See docs/PV_V3_FINAL_v34.md section 11 for ratio validation.
     */
    function depositJunior(
        address baseToken,
        uint256 baseAmount,
        uint256 wethAmount,
        address /* depositor */
    ) external override onlyTranche(TrancheId.JUNIOR) whenNotShortfallPaused returns (uint256 totalBaseValue) {
        if (baseAmount == 0 && wethAmount == 0) revert PrimeVaults__ZeroAmount();

        // 1. Update accounting
        _updateAccounting();

        // 2. Validate WETH ratio
        uint256 wethPrice = i_wethOracle.getWETHPrice();
        uint256 wethValueUSD = (wethAmount * wethPrice) / PRECISION;
        uint256 totalValueUSD = baseAmount + wethValueUSD;

        if (totalValueUSD > 0) {
            uint256 wethRatio = (wethValueUSD * PRECISION) / totalValueUSD;
            uint256 target = _getTargetRatio();
            uint256 tolerance = _getTolerance(target);
            if (wethRatio < target - tolerance || wethRatio > target + tolerance) {
                revert PrimeVaults__RatioOutOfBounds(wethRatio, target, tolerance);
            }
        }

        // 3. Route base to strategy
        if (baseAmount > 0) {
            IERC20(baseToken).safeTransferFrom(msg.sender, address(this), baseAmount);
            IERC20(baseToken).forceApprove(address(i_strategy), baseAmount);
            i_strategy.depositToken(baseToken, baseAmount);
        }

        // 4. Route WETH to AaveWETHAdapter
        if (wethAmount > 0) {
            IERC20(i_weth).safeTransferFrom(msg.sender, address(this), wethAmount);
            IERC20(i_weth).forceApprove(address(i_aaveWETHAdapter), wethAmount);
            i_aaveWETHAdapter.supply(wethAmount);
        }

        // 5. Record in accounting
        //    recordDeposit → increases s_juniorBaseTVL (base only)
        //    setJuniorWethTVL → sets s_juniorWethTVL separately (tracked independently)
        totalBaseValue = baseAmount + wethValueUSD;
        i_accounting.recordDeposit(TrancheId.JUNIOR, baseAmount);
        if (wethValueUSD > 0) {
            i_accounting.setJuniorWethTVL(i_aaveWETHAdapter.totalAssetsUSD());
        }

        // 6. Check junior shortfall
        _checkJuniorShortfall();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW — IPrimeCDO
    // ═══════════════════════════════════════════════════════════════════

    function accounting() external view override returns (address) {
        return address(i_accounting);
    }

    function strategy() external view override returns (address) {
        return address(i_strategy);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  WITHDRAW — All tranches
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Request withdrawal from any tranche.
     * @dev Flow: update accounting → compute fee → route to mechanism.
     *      Mechanism selected by RedemptionPolicy based on per-tranche coverage.
     */
    function requestWithdraw(
        TrancheId tranche,
        uint256 baseAmount,
        address outputToken,
        address beneficiary,
        uint256 vaultShares
    ) external override onlyTranche(tranche) whenNotShortfallPaused returns (CDOWithdrawResult memory result) {
        if (baseAmount == 0) revert PrimeVaults__ZeroAmount();
        _updateAccounting();

        // Fee from RedemptionPolicy
        RedemptionPolicy.PolicyResult memory policy = i_redemptionPolicy.evaluate(tranche);
        uint256 feeAmount = (baseAmount * policy.feeBps) / 10_000;
        uint256 netAmount = baseAmount - feeAmount;
        if (feeAmount > 0) i_accounting.recordFee(tranche, feeAmount);

        // Route to mechanism
        if (policy.mechanism == RedemptionPolicy.CooldownMechanism.NONE) {
            result = _withdrawInstant(tranche, netAmount, outputToken, beneficiary, feeAmount);
        } else if (policy.mechanism == RedemptionPolicy.CooldownMechanism.ASSETS_LOCK) {
            result = _withdrawAssetsLock(tranche, netAmount, outputToken, beneficiary, feeAmount);
        } else {
            result = _withdrawSharesLock(tranche, beneficiary, vaultShares, feeAmount);
        }

        _checkJuniorShortfall();
    }

    /**
     * @dev NONE mechanism: withdraw from strategy directly to beneficiary.
     *      Senior: always. Mezz: cs > 160%. Junior: cs > 160% AND cm > 150%.
     */
    function _withdrawInstant(
        TrancheId tranche,
        uint256 netAmount,
        address outputToken,
        address beneficiary,
        uint256 feeAmount
    ) internal returns (CDOWithdrawResult memory) {
        WithdrawResult memory wr = i_strategy.withdraw(netAmount, outputToken, beneficiary);
        i_accounting.recordWithdraw(tranche, netAmount);

        return
            CDOWithdrawResult({
                isInstant: true,
                amountOut: wr.amountOut,
                cooldownId: 0,
                cooldownHandler: address(0),
                unlockTime: 0,
                feeAmount: feeAmount,
                appliedCooldownType: 0
            });
    }

    /**
     * @dev ASSETS_LOCK mechanism: withdraw from strategy to CDO, then lock in ERC20Cooldown.
     *      If strategy returns UNSTAKE instead (external cooldown), pass through.
     *      Mezz: 140% < cs ≤ 160%. Junior: cs > 140% AND cm > 130%.
     */
    function _withdrawAssetsLock(
        TrancheId tranche,
        uint256 netAmount,
        address outputToken,
        address beneficiary,
        uint256 feeAmount
    ) internal returns (CDOWithdrawResult memory) {
        // Withdraw to CDO (not beneficiary) so we can lock in cooldown
        WithdrawResult memory wr = i_strategy.withdraw(netAmount, outputToken, address(this));
        i_accounting.recordWithdraw(tranche, netAmount);

        if (wr.wType == WithdrawType.INSTANT) {
            // Strategy returned tokens to CDO → lock in ERC20Cooldown
            IERC20(outputToken).forceApprove(address(i_erc20Cooldown), wr.amountOut);
            uint256 requestId = i_erc20Cooldown.request(beneficiary, outputToken, wr.amountOut);

            return
                CDOWithdrawResult({
                    isInstant: false,
                    amountOut: 0,
                    cooldownId: requestId,
                    cooldownHandler: address(i_erc20Cooldown),
                    unlockTime: 0,
                    feeAmount: feeAmount,
                    appliedCooldownType: 1
                });
        }

        // Strategy initiated external cooldown (UNSTAKE) — pass through
        return
            CDOWithdrawResult({
                isInstant: false,
                amountOut: 0,
                cooldownId: wr.cooldownId,
                cooldownHandler: wr.cooldownHandler,
                unlockTime: wr.unlockTime,
                feeAmount: feeAmount,
                appliedCooldownType: 2
            });
    }

    /**
     * @dev SHARES_LOCK mechanism: escrow vault shares in SharesCooldown.
     *      Strategy NOT touched — shares stay in totalSupply → TVL preserved → coverage stable.
     *      At claim via claimSharesWithdraw(): shares return to CDO, converted at current rate.
     *      Mezz: cs ≤ 140%. Junior: cs ≤ 140% OR cm ≤ 130%.
     */
    function _withdrawSharesLock(
        TrancheId tranche,
        address beneficiary,
        uint256 vaultShares,
        uint256 feeAmount
    ) internal returns (CDOWithdrawResult memory) {
        address vault = s_tranches[tranche];
        IERC20(vault).safeTransferFrom(msg.sender, address(this), vaultShares);
        IERC20(vault).forceApprove(address(i_sharesCooldown), vaultShares);
        uint256 requestId = i_sharesCooldown.request(beneficiary, vault, vaultShares);

        // Do NOT recordWithdraw — shares still in totalSupply, TVL unchanged
        return
            CDOWithdrawResult({
                isInstant: false,
                amountOut: 0,
                cooldownId: requestId,
                cooldownHandler: address(i_sharesCooldown),
                unlockTime: 0,
                feeAmount: feeAmount,
                appliedCooldownType: 3
            });
    }

    // ═══════════════════════════════════════════════════════════════════
    //  WITHDRAW — Junior (proportional base + WETH)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Withdraw from Junior tranche: proportional WETH (instant) + base (mechanism-routed).
     * @dev WETH portion always instant (withdrawn from Aave to beneficiary).
     *      Base portion follows RedemptionPolicy: NONE/ASSETS_LOCK/SHARES_LOCK.
     *      Junior is NEVER blocked — only fee escalation + cooldown at low coverage.
     */
    function withdrawJunior(
        uint256 baseAmount,
        address outputToken,
        address beneficiary,
        uint256 vaultShares,
        uint256 totalJuniorShares
    ) external override onlyTranche(TrancheId.JUNIOR) whenNotShortfallPaused returns (CDOWithdrawResult memory result) {
        if (baseAmount == 0 && vaultShares == 0) revert PrimeVaults__ZeroAmount();

        _updateAccounting();

        // Proportional WETH: always instant from Aave
        if (totalJuniorShares > 0) {
            uint256 totalWeth = i_aaveWETHAdapter.totalAssets();
            uint256 userWeth = (totalWeth * vaultShares) / totalJuniorShares;
            if (userWeth > 0) {
                i_aaveWETHAdapter.withdraw(userWeth, beneficiary);
                i_accounting.setJuniorWethTVL(i_aaveWETHAdapter.totalAssetsUSD());
            }
        }

        // Base portion: route through RedemptionPolicy mechanism
        if (baseAmount > 0) {
            RedemptionPolicy.PolicyResult memory policy = i_redemptionPolicy.evaluate(TrancheId.JUNIOR);
            uint256 feeAmount = (baseAmount * policy.feeBps) / 10_000;
            uint256 netAmount = baseAmount - feeAmount;
            if (feeAmount > 0) i_accounting.recordFee(TrancheId.JUNIOR, feeAmount);

            if (policy.mechanism == RedemptionPolicy.CooldownMechanism.NONE) {
                result = _withdrawInstant(TrancheId.JUNIOR, netAmount, outputToken, beneficiary, feeAmount);
            } else if (policy.mechanism == RedemptionPolicy.CooldownMechanism.ASSETS_LOCK) {
                result = _withdrawAssetsLock(TrancheId.JUNIOR, netAmount, outputToken, beneficiary, feeAmount);
            } else {
                result = _withdrawSharesLock(TrancheId.JUNIOR, beneficiary, vaultShares, feeAmount);
            }
        }

        _checkJuniorShortfall();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CLAIM
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Claim a completed ERC20Cooldown (ASSETS_LOCK) withdrawal.
     * @dev Delegates to a whitelisted cooldown handler. Callable by anyone.
     *      Tokens are released directly from the cooldown handler to the beneficiary.
     */
    function claimWithdraw(uint256 cooldownId, address cooldownHandler) external override returns (uint256 amountOut) {
        if (cooldownHandler != address(i_erc20Cooldown)) revert PrimeVaults__Unauthorized(cooldownHandler);
        amountOut = ICooldownHandler(cooldownHandler).claim(cooldownId);
    }

    /**
     * @notice Claim a completed SharesCooldown (SHARES_LOCK) withdrawal.
     * @dev Flow: claim shares from SharesCooldown → CDO receives vault shares →
     *      compute base value at current exchange rate → withdraw from strategy → send to beneficiary.
     *      User benefits from yield accrued during cooldown (shares appreciated).
     *      Callable by anyone.
     */
    function claimSharesWithdraw(
        uint256 cooldownId,
        address outputToken
    ) external override returns (uint256 amountOut) {
        // 1. Claim shares from SharesCooldown → shares come back to this CDO
        CooldownRequest memory req = i_sharesCooldown.getRequest(cooldownId);
        uint256 sharesReturned = i_sharesCooldown.claim(cooldownId);

        // 2. Determine tranche from the vault token stored in the request
        address vault = req.token;
        TrancheId tranche = s_vaultToTranche[vault];

        // 3. Compute base value of shares at current exchange rate
        //    baseAmount = shares × trancheTVL / totalSupply
        _updateAccounting();
        uint256 trancheTVL = i_accounting.getTrancheTVL(tranche);
        uint256 totalSupply = IERC20(vault).totalSupply();
        uint256 baseAmount = (sharesReturned * trancheTVL) / totalSupply;

        // 4. Record withdraw and withdraw from strategy to beneficiary
        i_accounting.recordWithdraw(tranche, baseAmount);
        WithdrawResult memory wr = i_strategy.withdraw(baseAmount, outputToken, req.beneficiary);
        amountOut = wr.amountOut;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  WETH COVERAGE — Loss Layer 0
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Sell WETH to cover a strategy loss and inject proceeds directly into strategy.
     * @dev Layer 0 of the loss waterfall. See docs/PV_V3_FINAL_v34.md section 43.
     *      Flow: withdraw WETH from Aave → swap to base via SwapFacility → deposit into strategy.
     *      Uses emergency slippage tier (10%) for the swap.
     * @param lossUSD Loss amount in USD (base-equivalent, 18 decimals)
     */
    function executeWETHCoverage(uint256 lossUSD) external onlyOwner {
        if (lossUSD == 0) revert PrimeVaults__ZeroAmount();

        _updateAccounting();

        // 1. Determine how much WETH to sell (lossUSD / wethPrice)
        uint256 wethPrice = i_wethOracle.getWETHPrice();
        uint256 wethNeeded = (lossUSD * PRECISION) / wethPrice;

        // 2. Cap at available WETH in Aave
        uint256 wethAvailable = i_aaveWETHAdapter.totalAssets();
        if (wethNeeded > wethAvailable) wethNeeded = wethAvailable;
        if (wethNeeded == 0) return;

        // 3. Withdraw WETH from Aave to CDO
        i_aaveWETHAdapter.withdraw(wethNeeded, address(this));

        // 4. Swap WETH → base asset via SwapFacility (emergency slippage)
        address baseAsset = i_strategy.baseAsset();
        uint256 minOut = i_swapFacility.getMinOutput(wethNeeded, wethPrice, true);
        IERC20(i_weth).forceApprove(address(i_swapFacility), wethNeeded);
        uint256 baseRecovered = i_swapFacility.swapWETHFor(baseAsset, wethNeeded, minOut);

        // 5. Inject directly into strategy (no registry routing)
        IERC20(baseAsset).forceApprove(address(i_strategy), baseRecovered);
        i_strategy.deposit(baseRecovered);

        // 6. Update WETH TVL in accounting
        i_accounting.setJuniorWethTVL(i_aaveWETHAdapter.totalAssetsUSD());

        emit WETHCoverageExecuted(lossUSD, wethNeeded, baseRecovered);

        _checkJuniorShortfall();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  REBALANCE — Asymmetric (Section 12)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Sell excess WETH when ratio exceeds target + tolerance (ETH price rose).
     * @dev Permissionless — anyone can call. Cannot extract value.
     *      Flow: withdraw excess WETH from Aave → swap to base → deposit into strategy.
     *      See docs/PV_V3_FINAL_v34.md section 12 (asymmetric rebalance).
     *      See MATH_REFERENCE §F4 for rebalance amounts.
     */
    function rebalanceSellWETH() external override {
        _updateAccounting();

        // 1. Compute current WETH ratio
        uint256 wethPrice = i_wethOracle.getWETHPrice();
        uint256 wethAssets = i_aaveWETHAdapter.totalAssets();
        uint256 wethValueUSD = (wethAssets * wethPrice) / PRECISION;
        uint256 juniorTVL = i_accounting.getJuniorTVL();

        if (juniorTVL == 0) revert PrimeVaults__RatioWithinBounds(0);

        uint256 currentRatio = (wethValueUSD * PRECISION) / juniorTVL;
        uint256 target = _getTargetRatio();
        uint256 tolerance = _getTolerance(target);

        // 2. Revert if ratio within bounds
        if (currentRatio <= target + tolerance) revert PrimeVaults__RatioWithinBounds(currentRatio);

        // 3. Compute excess WETH to sell → bring ratio back to target
        //    excessUSD = wethValueUSD - (target × juniorTVL / PRECISION)
        uint256 targetWethUSD = (target * juniorTVL) / PRECISION;
        uint256 excessUSD = wethValueUSD - targetWethUSD;
        uint256 excessWETH = (excessUSD * PRECISION) / wethPrice;

        // 4. Withdraw from Aave → swap → deposit into strategy
        i_aaveWETHAdapter.withdraw(excessWETH, address(this));

        address baseAsset = i_strategy.baseAsset();
        uint256 minOut = i_swapFacility.getMinOutput(excessWETH, wethPrice, false);
        IERC20(i_weth).forceApprove(address(i_swapFacility), excessWETH);
        uint256 baseReceived = i_swapFacility.swapWETHFor(baseAsset, excessWETH, minOut);

        IERC20(baseAsset).forceApprove(address(i_strategy), baseReceived);
        i_strategy.deposit(baseReceived);

        // 5. Update WETH TVL
        i_accounting.setJuniorWethTVL(i_aaveWETHAdapter.totalAssetsUSD());

        // 6. Compute new ratio for event
        uint256 newWethUSD = i_aaveWETHAdapter.totalAssetsUSD();
        uint256 newJrTVL = i_accounting.getJuniorTVL();
        uint256 newRatio = newJrTVL > 0 ? (newWethUSD * PRECISION) / newJrTVL : 0;

        emit RebalanceSellExecuted(excessWETH, baseReceived, newRatio);
    }

    /**
     * @notice Buy WETH when ratio drops below target - tolerance (ETH price dropped).
     * @dev Governance-only. Recalls base from strategy → swaps to WETH → supplies Aave.
     *      See docs/PV_V3_FINAL_v34.md section 12.
     * @param maxBaseToRecall Maximum base asset to recall from strategy (caps exposure)
     */
    function rebalanceBuyWETH(uint256 maxBaseToRecall) external override onlyOwner {
        _updateAccounting();

        // 1. Compute current WETH ratio
        uint256 wethPrice = i_wethOracle.getWETHPrice();
        uint256 wethAssets = i_aaveWETHAdapter.totalAssets();
        uint256 wethValueUSD = (wethAssets * wethPrice) / PRECISION;
        uint256 juniorTVL = i_accounting.getJuniorTVL();

        if (juniorTVL == 0) revert PrimeVaults__RatioWithinBounds(0);

        uint256 currentRatio = (wethValueUSD * PRECISION) / juniorTVL;
        uint256 target = _getTargetRatio();
        uint256 tolerance = _getTolerance(target);

        // 2. Revert if ratio within bounds
        if (currentRatio >= target - tolerance) revert PrimeVaults__RatioWithinBounds(currentRatio);

        // 3. Compute base needed to buy WETH → bring ratio back to target
        //    deficitUSD = (target × juniorTVL / PRECISION) - wethValueUSD
        uint256 targetWethUSD = (target * juniorTVL) / PRECISION;
        uint256 deficitUSD = targetWethUSD - wethValueUSD;

        // 4. Cap at maxBaseToRecall
        if (deficitUSD > maxBaseToRecall) deficitUSD = maxBaseToRecall;

        // 5. Recall base from strategy
        address baseAsset = i_strategy.baseAsset();
        WithdrawResult memory wr = i_strategy.withdraw(deficitUSD, baseAsset, address(this));

        // 6. Swap base → WETH
        uint256 baseToSwap = wr.amountOut;
        uint256 expectedWeth = (baseToSwap * PRECISION) / wethPrice;
        uint256 minWethOut = (expectedWeth * 9900) / 10_000; // 1% slippage
        IERC20(baseAsset).forceApprove(address(i_swapFacility), baseToSwap);
        uint256 wethReceived = i_swapFacility.swapForWETH(baseAsset, baseToSwap, minWethOut);

        // 7. Supply WETH to Aave
        IERC20(i_weth).forceApprove(address(i_aaveWETHAdapter), wethReceived);
        i_aaveWETHAdapter.supply(wethReceived);

        // 8. Update accounting
        i_accounting.setJuniorWethTVL(i_aaveWETHAdapter.totalAssetsUSD());

        // 9. Compute new ratio for event
        uint256 newWethUSD = i_aaveWETHAdapter.totalAssetsUSD();
        uint256 newJrTVL = i_accounting.getJuniorTVL();
        uint256 newRatio = newJrTVL > 0 ? (newWethUSD * PRECISION) / newJrTVL : 0;

        emit RebalanceBuyExecuted(baseToSwap, wethReceived, newRatio);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function registerTranche(TrancheId id, address vault) external onlyOwner {
        s_tranches[id] = vault;
        s_vaultToTranche[vault] = id;
        emit TrancheRegistered(id, vault);
    }

    function setMinCoverageForDeposit(uint256 minCoverage) external onlyOwner {
        s_minCoverageForDeposit = minCoverage;
    }

    function setJuniorShortfallPausePrice(uint256 price) external onlyOwner {
        s_juniorShortfallPausePrice = price;
    }

    function unpauseShortfall() external onlyOwner {
        s_shortfallPaused = false;
        emit ShortfallUnpaused();
    }

    function setRatioTarget(uint256 target) external onlyOwner {
        s_ratioTarget = target;
    }

    function setRatioTolerance(uint256 tolerance) external onlyOwner {
        s_ratioTolerance = tolerance;
    }

    function setRatioController(address controller) external onlyOwner {
        s_ratioController = controller;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    function _updateAccounting() internal {
        uint256 strategyTVL = i_strategy.totalAssets();
        uint256 wethUSD = i_aaveWETHAdapter.totalAssetsUSD();
        i_accounting.updateTVL(strategyTVL, wethUSD);
    }

    /**
     * @dev Senior coverage: cs = (Sr + Mz + Jr) / Sr.
     *      If Sr=0: empty protocol → max (allow first deposit).
     */
    function _getCoverageSenior() internal view returns (uint256) {
        (uint256 sr, uint256 mz, uint256 jr) = i_accounting.getAllTVLs();
        if (sr == 0) {
            if (mz + jr > 0) return type(uint256).max; // Sr doesn't exist yet, no gate needed
            return type(uint256).max; // empty protocol → allow first deposit
        }
        return ((sr + mz + jr) * PRECISION) / sr;
    }

    /**
     * @dev Mezzanine coverage: cm = (Mz + Jr) / Mz.
     *      If Mz=0: empty → max (allow first deposit).
     */
    function _getCoverageMezz() internal view returns (uint256) {
        (, uint256 mz, uint256 jr) = i_accounting.getAllTVLs();
        if (mz == 0) {
            if (jr > 0) return type(uint256).max; // Mz doesn't exist yet
            return type(uint256).max; // empty
        }
        return ((mz + jr) * PRECISION) / mz;
    }

    /**
     * @dev Auto-pause if Junior exchange rate drops below threshold.
     *      See docs/PV_V3_COVERAGE_GATE.md section 5.
     */
    function _checkJuniorShortfall() internal {
        if (s_juniorShortfallPausePrice == 0) return;

        address juniorVault = s_tranches[TrancheId.JUNIOR];
        if (juniorVault == address(0)) return;

        uint256 totalAssets = i_accounting.getJuniorTVL();
        uint256 totalSupply = IERC20(juniorVault).totalSupply();

        if (totalSupply == 0) return;

        uint256 pricePerShare = (totalAssets * PRECISION) / totalSupply;

        if (pricePerShare < s_juniorShortfallPausePrice) {
            s_shortfallPaused = true;
            emit ShortfallPauseTriggered(pricePerShare, s_juniorShortfallPausePrice);
        }
    }

    /**
     * @dev Get target WETH ratio. Fixed 20% at launch, upgradeable via controller.
     */
    function _getTargetRatio() internal view returns (uint256) {
        if (s_ratioController == address(0)) return s_ratioTarget;
        return IRatioController(s_ratioController).getTargetRatio();
    }

    /**
     * @dev Get ratio tolerance. Fixed 2% at launch, upgradeable via controller.
     */
    function _getTolerance(uint256 target) internal view returns (uint256) {
        if (s_ratioController == address(0)) return s_ratioTolerance;
        return (target * s_ratioTolerance) / PRECISION;
    }
}
