// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — RedemptionPolicy
//  Coverage-based cooldown mechanism + fee selection
//  See: docs/PV_V3_FINAL_v34.md section 28, docs/PV_V3_COVERAGE_GATE.md
// ══════════════════════════════════════════════════════════════════════

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IAccounting} from "../interfaces/IAccounting.sol";
import {TrancheId} from "../interfaces/IPrimeCDO.sol";

/**
 * @title RedemptionPolicy
 * @notice Selects cooldown mechanism and fee based on current coverage ratio.
 * @dev Coverage = TVL_pool / TVL_jr. Higher coverage = healthier = lighter mechanism.
 *      Configurable per market via setRanges().
 *
 *      Default ranges:
 *        coverage > 2.0x   → NONE        (instant), 0 bps fee
 *        coverage 1.5-2.0x → ASSETS_LOCK (ERC20Cooldown), 10 bps fee
 *        coverage < 1.5x   → SHARES_LOCK (SharesCooldown), 50 bps fee
 *
 *      Note: UNSTAKE is determined by strategy (outputToken), not coverage.
 *      RedemptionPolicy only handles the coverage-dependent mechanism overlay.
 */
contract RedemptionPolicy is Ownable2Step {
    // ═══════════════════════════════════════════════════════════════════
    //  TYPES
    // ═══════════════════════════════════════════════════════════════════

    enum CooldownMechanism {
        NONE, // instant withdrawal
        ASSETS_LOCK, // lock assets in ERC20Cooldown
        SHARES_LOCK // lock shares in SharesCooldown
    }

    struct PolicyResult {
        CooldownMechanism mechanism;
        uint256 feeBps;
    }

    struct Range {
        uint256 minCoverage; // inclusive lower bound (1e18 scale)
        CooldownMechanism mechanism;
        uint256 feeBps;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_FEE_BPS = 1_000; // 10% max

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    IAccounting public s_accounting;

    // Ranges sorted ascending by minCoverage. Evaluated top-down (highest first).
    Range[] public s_ranges;

    // Default: used when coverage is below all range thresholds
    CooldownMechanism public s_defaultMechanism;
    uint256 public s_defaultFeeBps;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event RangesUpdated(uint256 rangeCount);
    event AccountingSet(address accounting);

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__RangesNotAscending();
    error PrimeVaults__FeeTooHigh(uint256 feeBps);

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address owner_, address accounting_) Ownable(owner_) {
        s_accounting = IAccounting(accounting_);

        // Default: SHARES_LOCK at 50 bps (lowest coverage tier)
        s_defaultMechanism = CooldownMechanism.SHARES_LOCK;
        s_defaultFeeBps = 50;

        // Initialize default ranges (ascending by minCoverage):
        //   coverage >= 1.5x → ASSETS_LOCK, 10 bps
        //   coverage >= 2.0x → NONE, 0 bps
        //   below 1.5x      → default (SHARES_LOCK, 50 bps)
        s_ranges.push(
            Range({
                minCoverage: 1_500_000_000_000_000_000,
                mechanism: CooldownMechanism.ASSETS_LOCK,
                feeBps: 10
            })
        );
        s_ranges.push(
            Range({
                minCoverage: 2_000_000_000_000_000_000,
                mechanism: CooldownMechanism.NONE,
                feeBps: 0
            })
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    //  QUERY
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Evaluate which mechanism and fee to apply based on current coverage.
     * @dev Iterates ranges from highest minCoverage to lowest (stored ascending, read descending).
     *      First range where coverage >= minCoverage wins. Falls through to default.
     * @return result PolicyResult with mechanism and feeBps
     */
    function evaluate() external view returns (PolicyResult memory result) {
        uint256 coverage = _getCoverage();
        return _evaluateForCoverage(coverage);
    }

    /**
     * @notice Evaluate for a specific coverage value (for testing/preview).
     */
    function evaluateForCoverage(
        uint256 coverage
    ) external view returns (PolicyResult memory) {
        return _evaluateForCoverage(coverage);
    }

    /**
     * @notice Get current coverage ratio from Accounting.
     */
    function getCurrentCoverage() external view returns (uint256) {
        return _getCoverage();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Set coverage ranges. Must be ascending by minCoverage.
     * @param ranges_ Array of Range structs, sorted ascending by minCoverage
     * @param defaultMechanism_ Mechanism for coverage below all ranges
     * @param defaultFeeBps_ Fee for coverage below all ranges
     */
    function setRanges(
        Range[] calldata ranges_,
        CooldownMechanism defaultMechanism_,
        uint256 defaultFeeBps_
    ) external onlyOwner {
        if (defaultFeeBps_ > MAX_FEE_BPS)
            revert PrimeVaults__FeeTooHigh(defaultFeeBps_);

        // Validate ascending order
        for (uint256 i = 1; i < ranges_.length; i++) {
            if (ranges_[i].minCoverage <= ranges_[i - 1].minCoverage)
                revert PrimeVaults__RangesNotAscending();
            if (ranges_[i].feeBps > MAX_FEE_BPS)
                revert PrimeVaults__FeeTooHigh(ranges_[i].feeBps);
        }
        if (ranges_.length > 0 && ranges_[0].feeBps > MAX_FEE_BPS)
            revert PrimeVaults__FeeTooHigh(ranges_[0].feeBps);

        // Clear and replace
        delete s_ranges;
        for (uint256 i = 0; i < ranges_.length; i++) {
            s_ranges.push(ranges_[i]);
        }

        s_defaultMechanism = defaultMechanism_;
        s_defaultFeeBps = defaultFeeBps_;

        emit RangesUpdated(ranges_.length);
    }

    /**
     * @notice Set the Accounting contract address.
     */
    function setAccounting(address accounting_) external onlyOwner {
        s_accounting = IAccounting(accounting_);
        emit AccountingSet(accounting_);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    function _evaluateForCoverage(
        uint256 coverage
    ) internal view returns (PolicyResult memory result) {
        // Iterate from highest threshold to lowest (stored ascending, read descending)
        uint256 len = s_ranges.length;
        for (uint256 i = len; i > 0; i--) {
            Range memory r = s_ranges[i - 1];
            if (coverage >= r.minCoverage) {
                return PolicyResult({mechanism: r.mechanism, feeBps: r.feeBps});
            }
        }
        // Below all ranges → default
        return
            PolicyResult({
                mechanism: s_defaultMechanism,
                feeBps: s_defaultFeeBps
            });
    }

    function _getCoverage() internal view returns (uint256) {
        (uint256 sr, uint256 mz, uint256 jr) = s_accounting.getAllTVLs();
        if (jr == 0) {
            if (sr + mz > 0) return 0;
            return type(uint256).max;
        }
        return ((sr + mz + jr) * PRECISION) / jr;
    }

    /** @notice Number of configured ranges. */
    function rangeCount() external view returns (uint256) {
        return s_ranges.length;
    }
}
