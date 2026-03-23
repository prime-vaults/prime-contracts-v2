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
 *      getAprPair() is state-changing — shifts internal snapshots on each call.
 */
interface IStrategyAprPairProvider {
    /**
     * @notice Compute and return the current APR pair.
     * @dev State-changing: may shift internal snapshots. Called by AprPairFeed.
     * @return aprTarget Benchmark APR (Aave weighted avg), int64 × 12 decimals
     * @return aprBase Strategy APR (vault yield), int64 × 12 decimals
     * @return timestamp Timestamp of the data point
     */
    function getAprPair() external returns (int64 aprTarget, int64 aprBase, uint64 timestamp);
}

/**
 * @title IAprPairFeed
 * @notice Strata-compatible APR feed with round history and dual-source (PUSH + PULL).
 * @dev Stores APR rounds in a circular buffer. Supports Feed (PUSH) and Strategy (PULL) modes.
 *      Accounting reads latestRoundData() to get current APR pair.
 */
interface IAprPairFeed {
    /**
     * @notice A single APR data round.
     * @param roundId Sequential round identifier
     * @param aprTarget Benchmark APR, int64 × 12 decimals
     * @param aprBase Strategy APR, int64 × 12 decimals
     * @param timestamp Data timestamp
     */
    struct TRound {
        uint64 roundId;
        int64 aprTarget;
        int64 aprBase;
        uint64 timestamp;
    }

    /**
     * @notice Source preference for latestRoundData().
     * @dev Feed: prefer cached feed data (PUSH), fall back to provider if stale.
     *      Strategy: always call provider (PULL).
     */
    enum ESourcePref {
        Feed,
        Strategy
    }

    /**
     * @notice Get the latest APR round data.
     * @dev If sourcePref == Feed: returns cached round if not stale, else calls provider.
     *      If sourcePref == Strategy: always calls provider.
     * @return round The latest TRound
     */
    function latestRoundData() external returns (TRound memory round);

    /**
     * @notice Get a historical APR round by ID.
     * @dev Reverts if round has been overwritten in the circular buffer.
     * @param roundId The round to retrieve
     * @return round The requested TRound
     */
    function getRoundData(uint64 roundId) external view returns (TRound memory round);
}
