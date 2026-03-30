// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — RedemptionPolicy
//  Per-tranche coverage-based cooldown mechanism + fee selection
//  See: docs/PV_V3_FINAL_v34.md section 28, docs/PV_V3_COVERAGE_GATE.md
// ══════════════════════════════════════════════════════════════════════

import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IAccounting } from "../interfaces/IAccounting.sol";
import { TrancheId } from "../interfaces/IPrimeCDO.sol";

/**
 * @title RedemptionPolicy
 * @notice Per-tranche cooldown mechanism and fee selection based on coverage ratios.
 * @dev Two coverage metrics:
 *        cs = (Sr + Mz + Jr) / Sr  → Senior coverage
 *        cm = (Mz + Jr) / Mz       → Mezz coverage
 *
 *      Senior:  always instant (no cooldown).
 *      Mezz:    based on cs only — instant cs>instantCs, asset lock assetLockCs<cs≤instantCs, share lock cs≤assetLockCs.
 *      Junior:  two-dimensional (cs, cm) — instant cm>instantCm&&cs>instantCs, asset lock cm>assetLockCm&&cs>assetLockCs, else share lock.
 *
 *      All thresholds, durations, and fees are governance-configurable.
 *      See docs/PV_V3_FINAL_v34.md section 28, docs/PV_V3_COVERAGE_GATE.md
 */
contract RedemptionPolicy is Ownable2Step {
    // ═══════════════════════════════════════════════════════════════════
    //  TYPES
    // ═══════════════════════════════════════════════════════════════════

    enum CooldownMechanism {
        NONE, // instant
        ASSETS_LOCK, // lock assets in ERC20Cooldown
        SHARES_LOCK // lock shares in SharesCooldown
    }

    struct PolicyResult {
        CooldownMechanism mechanism;
        uint256 feeBps;
        uint256 cooldownDuration;
    }

    /** @dev Thresholds and params for Mezz tranche (single-dimensional: cs only) */
    struct MezzParams {
        uint256 instantCs; // cs > instantCs → NONE
        uint256 assetLockCs; // cs > assetLockCs → ASSETS_LOCK
        // cs ≤ assetLockCs → SHARES_LOCK
    }

    /** @dev Thresholds and params for Junior tranche (two-dimensional: cs and cm) */
    struct JuniorParams {
        uint256 instantCs; // cs > instantCs AND cm > instantCm → NONE
        uint256 instantCm;
        uint256 assetLockCs; // cs > assetLockCs AND cm > assetLockCm → ASSETS_LOCK
        uint256 assetLockCm;
        // else → SHARES_LOCK
    }

    /** @dev Fee and duration per mechanism */
    struct MechanismConfig {
        uint256 instantFeeBps;
        uint256 assetsLockFeeBps;
        uint256 assetsLockDuration;
        uint256 sharesLockFeeBps;
        uint256 sharesLockDuration;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_FEE_BPS = 1_000; // 10%

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    IAccounting public s_accounting;

    MezzParams public s_mezzParams;
    JuniorParams public s_juniorParams;

    // Per-tranche fee/duration config
    mapping(TrancheId => MechanismConfig) public s_mechanismConfig;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event AccountingSet(address accounting);
    event MezzParamsUpdated(uint256 instantCs, uint256 assetLockCs);
    event JuniorParamsUpdated(uint256 instantCs, uint256 instantCm, uint256 assetLockCs, uint256 assetLockCm);
    event MechanismConfigUpdated(TrancheId indexed tranche);

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__FeeTooHigh(uint256 feeBps);
    error PrimeVaults__InvalidThresholds();

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address owner_, address accounting_) Ownable(owner_) {
        s_accounting = IAccounting(accounting_);
        _initDefaults();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  QUERY
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Evaluate policy for a tranche based on live coverage from Accounting.
     * @dev Senior: always instant. Mezz: evaluated against cs. Junior: evaluated against (cs, cm).
     * @param tranche The tranche requesting withdrawal
     * @return result The cooldown mechanism, fee, and duration
     */
    function evaluate(TrancheId tranche) external view returns (PolicyResult memory result) {
        if (tranche == TrancheId.SENIOR) return _buildResult(tranche, CooldownMechanism.NONE);

        (uint256 cs, uint256 cm) = _getCoverages();

        if (tranche == TrancheId.MEZZ) return _buildResult(tranche, _evaluateMezzMechanism(cs));
        return _buildResult(tranche, _evaluateJuniorMechanism(cs, cm));
    }

    /**
     * @notice Evaluate for explicit coverage values (testing/preview).
     * @param tranche The tranche requesting withdrawal
     * @param cs Senior coverage (1e18 scale)
     * @param cm Mezz coverage (1e18 scale)
     * @return result The cooldown mechanism, fee, and duration
     */
    function evaluateForCoverage(
        TrancheId tranche,
        uint256 cs,
        uint256 cm
    ) external view returns (PolicyResult memory result) {
        if (tranche == TrancheId.SENIOR) return _buildResult(tranche, CooldownMechanism.NONE);
        if (tranche == TrancheId.MEZZ) return _buildResult(tranche, _evaluateMezzMechanism(cs));
        return _buildResult(tranche, _evaluateJuniorMechanism(cs, cm));
    }

    /**
     * @notice Get senior coverage (cs) and mezz coverage (cm) from Accounting.
     * @dev cs = (Sr+Mz+Jr)/Sr, cm = (Mz+Jr)/Mz
     * @return cs Senior coverage (1e18 scale, type(uint256).max if Sr == 0)
     * @return cm Mezz coverage (1e18 scale, type(uint256).max if Mz == 0)
     */
    function getCoverages() external view returns (uint256 cs, uint256 cm) {
        return _getCoverages();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setAccounting(address accounting_) external onlyOwner {
        s_accounting = IAccounting(accounting_);
        emit AccountingSet(accounting_);
    }

    /** @notice Update Mezz coverage thresholds. instantCs must be > assetLockCs. */
    function setMezzParams(uint256 instantCs_, uint256 assetLockCs_) external onlyOwner {
        if (instantCs_ <= assetLockCs_) revert PrimeVaults__InvalidThresholds();
        s_mezzParams = MezzParams({ instantCs: instantCs_, assetLockCs: assetLockCs_ });
        emit MezzParamsUpdated(instantCs_, assetLockCs_);
    }

    /** @notice Update Junior coverage thresholds. Instant thresholds must be > asset lock thresholds. */
    function setJuniorParams(
        uint256 instantCs_,
        uint256 instantCm_,
        uint256 assetLockCs_,
        uint256 assetLockCm_
    ) external onlyOwner {
        if (instantCs_ <= assetLockCs_ || instantCm_ <= assetLockCm_) revert PrimeVaults__InvalidThresholds();
        s_juniorParams = JuniorParams({
            instantCs: instantCs_,
            instantCm: instantCm_,
            assetLockCs: assetLockCs_,
            assetLockCm: assetLockCm_
        });
        emit JuniorParamsUpdated(instantCs_, instantCm_, assetLockCs_, assetLockCm_);
    }

    /** @notice Update fee and duration config for a tranche. */
    function setMechanismConfig(TrancheId tranche, MechanismConfig calldata config_) external onlyOwner {
        if (config_.instantFeeBps > MAX_FEE_BPS) revert PrimeVaults__FeeTooHigh(config_.instantFeeBps);
        if (config_.assetsLockFeeBps > MAX_FEE_BPS) revert PrimeVaults__FeeTooHigh(config_.assetsLockFeeBps);
        if (config_.sharesLockFeeBps > MAX_FEE_BPS) revert PrimeVaults__FeeTooHigh(config_.sharesLockFeeBps);
        s_mechanismConfig[tranche] = config_;
        emit MechanismConfigUpdated(tranche);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    /** @dev Compute cs and cm from Accounting TVLs. */
    function _getCoverages() internal view returns (uint256 cs, uint256 cm) {
        (uint256 sr, uint256 mz, uint256 jr) = s_accounting.getAllTVLs();
        cs = sr > 0 ? ((sr + mz + jr) * PRECISION) / sr : type(uint256).max;
        cm = mz > 0 ? ((mz + jr) * PRECISION) / mz : type(uint256).max;
    }

    /** @dev Mezz mechanism: instant if cs > instantCs, asset lock if cs > assetLockCs, else share lock. */
    function _evaluateMezzMechanism(uint256 cs) internal view returns (CooldownMechanism) {
        MezzParams memory p = s_mezzParams;
        if (cs > p.instantCs) return CooldownMechanism.NONE;
        if (cs > p.assetLockCs) return CooldownMechanism.ASSETS_LOCK;
        return CooldownMechanism.SHARES_LOCK;
    }

    /** @dev Junior mechanism: evaluate cs and cm independently, return the most restrictive (highest priority). */
    function _evaluateJuniorMechanism(uint256 cs, uint256 cm) internal view returns (CooldownMechanism) {
        JuniorParams memory p = s_juniorParams;

        CooldownMechanism csMech = cs > p.instantCs ? CooldownMechanism.NONE : cs > p.assetLockCs
            ? CooldownMechanism.ASSETS_LOCK
            : CooldownMechanism.SHARES_LOCK;

        CooldownMechanism cmMech = cm > p.instantCm ? CooldownMechanism.NONE : cm > p.assetLockCm
            ? CooldownMechanism.ASSETS_LOCK
            : CooldownMechanism.SHARES_LOCK;

        return csMech > cmMech ? csMech : cmMech;
    }

    /** @dev Build PolicyResult from mechanism + per-tranche config. */
    function _buildResult(TrancheId tranche, CooldownMechanism mechanism) internal view returns (PolicyResult memory) {
        MechanismConfig memory cfg = s_mechanismConfig[tranche];
        if (mechanism == CooldownMechanism.NONE) {
            return PolicyResult({ mechanism: CooldownMechanism.NONE, feeBps: cfg.instantFeeBps, cooldownDuration: 0 });
        } else if (mechanism == CooldownMechanism.ASSETS_LOCK) {
            return
                PolicyResult({
                    mechanism: CooldownMechanism.ASSETS_LOCK,
                    feeBps: cfg.assetsLockFeeBps,
                    cooldownDuration: cfg.assetsLockDuration
                });
        }
        return
            PolicyResult({
                mechanism: CooldownMechanism.SHARES_LOCK,
                feeBps: cfg.sharesLockFeeBps,
                cooldownDuration: cfg.sharesLockDuration
            });
    }

    /** @dev Set initial default thresholds, fees, and durations. */
    function _initDefaults() internal {
        // Mezz thresholds
        s_mezzParams = MezzParams({ instantCs: 1.60e18, assetLockCs: 1.40e18 });

        // Junior thresholds
        s_juniorParams = JuniorParams({
            instantCs: 1.60e18,
            instantCm: 1.50e18,
            assetLockCs: 1.40e18,
            assetLockCm: 1.30e18
        });

        // Senior: always instant, fee configurable
        s_mechanismConfig[TrancheId.SENIOR] = MechanismConfig({
            instantFeeBps: 0,
            assetsLockFeeBps: 0,
            assetsLockDuration: 0,
            sharesLockFeeBps: 0,
            sharesLockDuration: 0
        });

        // Mezz: 3 day asset lock, 7 day share lock
        s_mechanismConfig[TrancheId.MEZZ] = MechanismConfig({
            instantFeeBps: 0,
            assetsLockFeeBps: 10,
            assetsLockDuration: 3 days,
            sharesLockFeeBps: 50,
            sharesLockDuration: 7 days
        });

        // Junior: higher fees
        s_mechanismConfig[TrancheId.JUNIOR] = MechanismConfig({
            instantFeeBps: 0,
            assetsLockFeeBps: 20,
            assetsLockDuration: 3 days,
            sharesLockFeeBps: 100,
            sharesLockDuration: 7 days
        });
    }
}
