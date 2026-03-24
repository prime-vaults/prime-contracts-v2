// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — IAprPairFeed
//  Strata-compatible APR oracle interfaces (int64 × 12 decimals)
//  See: docs/PV_V3_APR_ORACLE.md
// ══════════════════════════════════════════════════════════════════════

/**
 * @title IStrategyAprPairProvider
 * @notice Interface for strategy-specific APR pair providers (Strata-compatible).
 * @dev Returns (aprTarget, aprBase) in int64 with 12 decimals.
 *      1% = 0.01 × 1e12 = 1e10. Supports negative APR (yield decrease).
 *      Two entry points:
 *        getAprPair()     — state-changing (shifts snapshots). Called by Feed PULL update.
 *        getAprPairView() — pure view (reads existing snapshots). Called by Feed fallback.
 */
interface IStrategyAprPairProvider {
    /**
     * @notice Compute and return the current APR pair (state-changing).
     * @dev Shifts internal snapshots. Called by AprPairFeed.updateRoundData() (PULL mode).
     * @return aprTarget Benchmark APR (Aave weighted avg), int64 × 12 decimals
     * @return aprBase Strategy APR (vault yield), int64 × 12 decimals
     * @return timestamp Timestamp of the data point
     */
    function getAprPair() external returns (int64 aprTarget, int64 aprBase, uint64 timestamp);

    /**
     * @notice Read current APR pair without modifying state (view).
     * @dev Reads existing snapshots only. Called by AprPairFeed.latestRoundData() fallback
     *      and setProvider() compatibility check. No side effects.
     * @return aprTarget Benchmark APR (Aave weighted avg), int64 × 12 decimals
     * @return aprBase Strategy APR (vault yield), int64 × 12 decimals
     * @return timestamp Timestamp of latest snapshot
     */
    function getAprPairView() external view returns (int64 aprTarget, int64 aprBase, uint64 timestamp);
}

/**
 * @title IAprPairFeed
 * @notice Strata-compatible APR feed with round history and dual-source (PUSH + PULL).
 * @dev Stores APR rounds in a circular buffer. Supports Feed (PUSH) and Strategy (PULL) modes.
 *      Accounting reads latestRoundData() to get current APR pair.
 */
interface IAprPairFeed {
    struct TRound {
        uint64 roundId;
        int64 aprTarget;
        int64 aprBase;
        uint64 timestamp;
    }

    enum ESourcePref {
        Feed,
        Strategy
    }

    /** @notice Get the latest APR round data (may call provider view as fallback). */
    function latestRoundData() external view returns (TRound memory round);

    /** @notice Get a historical APR round by ID. Reverts if overwritten. */
    function getRoundData(uint64 roundId) external view returns (TRound memory round);
}
