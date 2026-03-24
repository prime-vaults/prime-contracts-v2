// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — AprPairFeed
//  Strata-compatible dual-source APR feed with round history
//  See: docs/PV_V3_APR_ORACLE.md section 4
// ══════════════════════════════════════════════════════════════════════

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IAprPairFeed, IStrategyAprPairProvider} from "../interfaces/IAprPairFeed.sol";

/**
 * @title AprPairFeed
 * @notice Strata-compatible dual-source APR feed with circular buffer history.
 * @dev Design fix #1: latestRoundData() fallback calls getAprPairView() (view, no side effects).
 *      updateRoundData() calls getAprPair() (state-changing, shifts provider snapshots).
 *      setProvider() calls getAprPairView() for compatibility check (no side effects).
 *      PULL-only: UPDATER_FEED_ROLE calls updateRoundData() → provider.getAprPair()
 *      APR values: int64 × 12 decimals. Bounds: [-50%, +200%].
 *      20-round circular buffer for historical access.
 */
contract AprPairFeed is AccessControl, IAprPairFeed {
    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    bytes32 public constant UPDATER_FEED_ROLE = keccak256("UPDATER_FEED_ROLE");
    uint256 public constant MAX_ROUNDS = 20;

    int64 public constant APR_LOWER_BOUND = -500_000_000_000;  // -50%
    int64 public constant APR_UPPER_BOUND = 2_000_000_000_000; // +200%

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    IStrategyAprPairProvider public s_provider;

    TRound[20] public s_rounds;
    uint64 public s_currentRoundId;
    uint64 public s_oldestRoundId;

    ESourcePref public s_sourcePref;
    uint256 public s_staleAfter;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event RoundUpdated(uint64 indexed roundId, int64 aprTarget, int64 aprBase, uint64 timestamp);
    event SourcePrefUpdated(ESourcePref pref);
    event StaleAfterUpdated(uint256 staleAfter);
    event ProviderUpdated(address provider);

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__AprOutOfBounds(int64 value, int64 lower, int64 upper);
    error PrimeVaults__TimestampOutOfOrder(uint64 provided, uint64 lastStored);
    error PrimeVaults__RoundNotAvailable(uint64 roundId);
    error PrimeVaults__NoRoundData();

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address provider_, address admin_, uint256 staleAfter_) {
        s_provider = IStrategyAprPairProvider(provider_);
        s_staleAfter = staleAfter_;
        s_sourcePref = ESourcePref.Feed;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(UPDATER_FEED_ROLE, admin_);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  UPDATE — PULL from provider
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Fetch APR from provider (state-changing) and store as new round.
     * @dev Calls getAprPair() which shifts provider snapshots. This is intentional —
     *      updateRoundData is the mechanism that advances the provider's snapshot window.
     */
    function updateRoundData() external onlyRole(UPDATER_FEED_ROLE) {
        (int64 aprTarget, int64 aprBase, uint64 timestamp) = s_provider.getAprPair();
        _validateBounds(aprTarget);
        _validateBounds(aprBase);
        _validateTimestamp(timestamp);
        _storeRound(aprTarget, aprBase, timestamp);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  READ
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Get the latest APR round data.
     * @dev Feed mode: returns cached round if fresh, else calls getAprPairView() (no side effects).
     *      Strategy mode: always calls getAprPairView() (no side effects).
     *      Fix #1: fallback uses getAprPairView(), NOT getAprPair(). No snapshot shift on read.
     */
    function latestRoundData() external view override returns (TRound memory round) {
        if (s_sourcePref == ESourcePref.Strategy) {
            (int64 aprTarget, int64 aprBase, uint64 timestamp) = s_provider.getAprPairView();
            return TRound({roundId: 0, aprTarget: aprTarget, aprBase: aprBase, timestamp: timestamp});
        }

        // Feed mode: use cached if fresh
        if (s_currentRoundId == 0) revert PrimeVaults__NoRoundData();

        uint256 idx = (s_currentRoundId - 1) % MAX_ROUNDS;
        round = s_rounds[idx];

        // If stale, fall back to provider VIEW (no side effects)
        if (block.timestamp - uint256(round.timestamp) > s_staleAfter) {
            (int64 aprTarget, int64 aprBase, uint64 timestamp) = s_provider.getAprPairView();
            return TRound({roundId: 0, aprTarget: aprTarget, aprBase: aprBase, timestamp: timestamp});
        }
    }

    /**
     * @notice Get a historical APR round by ID.
     * @param roundId The round to retrieve
     */
    function getRoundData(uint64 roundId) external view override returns (TRound memory round) {
        if (roundId == 0 || roundId > s_currentRoundId || roundId < s_oldestRoundId) {
            revert PrimeVaults__RoundNotAvailable(roundId);
        }

        uint256 idx = (roundId - 1) % MAX_ROUNDS;
        round = s_rounds[idx];

        if (round.roundId != roundId) revert PrimeVaults__RoundNotAvailable(roundId);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Set a new provider. Calls getAprPairView() for compatibility check (no side effects).
     * @param provider_ New provider address
     */
    function setProvider(address provider_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        IStrategyAprPairProvider newProvider = IStrategyAprPairProvider(provider_);
        // Compatibility check — view call, no side effects
        newProvider.getAprPairView();
        s_provider = newProvider;
        emit ProviderUpdated(provider_);
    }

    /**
     * @notice Set the source preference for latestRoundData().
     */
    function setSourcePref(ESourcePref pref) external onlyRole(DEFAULT_ADMIN_ROLE) {
        s_sourcePref = pref;
        emit SourcePrefUpdated(pref);
    }

    /**
     * @notice Update the staleness threshold for Feed mode.
     */
    function setStaleAfter(uint256 staleAfter_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        s_staleAfter = staleAfter_;
        emit StaleAfterUpdated(staleAfter_);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    function _validateBounds(int64 value) internal pure {
        if (value < APR_LOWER_BOUND || value > APR_UPPER_BOUND) {
            revert PrimeVaults__AprOutOfBounds(value, APR_LOWER_BOUND, APR_UPPER_BOUND);
        }
    }

    function _validateTimestamp(uint64 timestamp) internal view {
        if (s_currentRoundId > 0) {
            uint256 idx = (s_currentRoundId - 1) % MAX_ROUNDS;
            uint64 lastTs = s_rounds[idx].timestamp;
            if (timestamp <= lastTs) revert PrimeVaults__TimestampOutOfOrder(timestamp, lastTs);
        }
    }

    function _storeRound(int64 aprTarget, int64 aprBase, uint64 timestamp) internal {
        s_currentRoundId++;
        uint256 idx = (s_currentRoundId - 1) % MAX_ROUNDS;

        s_rounds[idx] = TRound({roundId: s_currentRoundId, aprTarget: aprTarget, aprBase: aprBase, timestamp: timestamp});

        if (s_currentRoundId > uint64(MAX_ROUNDS)) {
            s_oldestRoundId = s_currentRoundId - uint64(MAX_ROUNDS) + 1;
        } else if (s_oldestRoundId == 0) {
            s_oldestRoundId = 1;
        }

        emit RoundUpdated(s_currentRoundId, aprTarget, aprBase, timestamp);
    }
}
