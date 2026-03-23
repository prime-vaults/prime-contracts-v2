// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — SUSDaiAprProvider
//  Computes sUSDai APR from exchange rate snapshots (keeper-driven)
//  See: docs/PV_V3_APR_ORACLE.md section 3
// ══════════════════════════════════════════════════════════════════════

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/**
 * @title SUSDaiAprProvider
 * @notice Computes sUSDai APR from exchange rate snapshots.
 * @dev Keeper calls snapshot() every ~24h to record sUSDai.convertToAssets(1e18).
 *      APR = annualized growth between the two most recent snapshots.
 *      sUSDai contract: 0x0B2b2B2076d95dda7817e785989fE353fe955ef9 (Arbitrum)
 *      See MATH_REFERENCE §H3 for yield oracle formula.
 */
contract SUSDaiAprProvider is Ownable2Step {
    // ═══════════════════════════════════════════════════════════════════
    //  TYPES
    // ═══════════════════════════════════════════════════════════════════

    struct RateSnapshot {
        uint256 rate;
        uint256 timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS & IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    IERC4626 public immutable i_sUSDai;
    uint256 public constant MIN_SNAPSHOT_INTERVAL = 1 hours;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    RateSnapshot public s_prevSnapshot;
    RateSnapshot public s_latestSnapshot;
    mapping(address => bool) public s_keepers;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event SnapshotRecorded(uint256 rate, uint256 timestamp);
    event KeeperUpdated(address indexed keeper, bool active);

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__SnapshotTooSoon(uint256 elapsed, uint256 minimum);
    error PrimeVaults__NoSnapshotYet();
    error PrimeVaults__OnlyKeeper();

    // ═══════════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyKeeper() {
        if (!s_keepers[msg.sender]) revert PrimeVaults__OnlyKeeper();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address sUSDai_, address initialKeeper, address owner_) Ownable(owner_) {
        i_sUSDai = IERC4626(sUSDai_);
        s_keepers[initialKeeper] = true;

        // Seed first snapshot at deploy time
        uint256 currentRate = IERC4626(sUSDai_).convertToAssets(1e18);
        s_latestSnapshot = RateSnapshot({rate: currentRate, timestamp: block.timestamp});
        // s_prevSnapshot stays zero — APR not available until second snapshot
    }

    // ═══════════════════════════════════════════════════════════════════
    //  SNAPSHOT (keeper calls periodically)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Record sUSDai exchange rate — keeper calls every ~24h.
     * @dev Shifts latestSnapshot → prevSnapshot, records new latest.
     *      MIN_SNAPSHOT_INTERVAL prevents spam (1 hour minimum).
     */
    function snapshot() external onlyKeeper {
        uint256 elapsed = block.timestamp - s_latestSnapshot.timestamp;
        if (elapsed < MIN_SNAPSHOT_INTERVAL) revert PrimeVaults__SnapshotTooSoon(elapsed, MIN_SNAPSHOT_INTERVAL);

        s_prevSnapshot = s_latestSnapshot;

        uint256 currentRate = i_sUSDai.convertToAssets(1e18);
        s_latestSnapshot = RateSnapshot({rate: currentRate, timestamp: block.timestamp});

        emit SnapshotRecorded(currentRate, block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  FETCH APR
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Compute sUSDai APR from the two most recent snapshots.
     * @dev APR = (rate_now / rate_prev - 1) × 365 days / deltaT
     *      Reverts if fewer than 2 snapshots exist.
     * @return aprBase Annualized APR, 1e18 scale
     */
    function fetchStrategyApr() external view returns (uint256 aprBase) {
        if (s_prevSnapshot.timestamp == 0) revert PrimeVaults__NoSnapshotYet();

        uint256 rateNow = s_latestSnapshot.rate;
        uint256 ratePrev = s_prevSnapshot.rate;
        uint256 deltaT = s_latestSnapshot.timestamp - s_prevSnapshot.timestamp;

        if (deltaT == 0 || ratePrev == 0) return 0;
        if (rateNow <= ratePrev) return 0;

        uint256 growth = (rateNow - ratePrev) * 1e18 / ratePrev;
        aprBase = growth * 365 days / deltaT;
    }

    /**
     * @notice Realtime APR estimate using latest snapshot + live rate.
     * @dev Less accurate than fetchStrategyApr() but more responsive.
     * @return aprLive Estimated live APR, 1e18 scale
     */
    function fetchLiveApr() external view returns (uint256 aprLive) {
        if (s_latestSnapshot.timestamp == 0) return 0;

        uint256 rateLive = i_sUSDai.convertToAssets(1e18);
        uint256 ratePrev = s_latestSnapshot.rate;
        uint256 deltaT = block.timestamp - s_latestSnapshot.timestamp;

        if (deltaT == 0 || ratePrev == 0 || rateLive <= ratePrev) return 0;

        uint256 growth = (rateLive - ratePrev) * 1e18 / ratePrev;
        aprLive = growth * 365 days / deltaT;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Add or remove a keeper address.
     * @param keeper Address to update
     * @param active true to add, false to remove
     */
    function setKeeper(address keeper, bool active) external onlyOwner {
        s_keepers[keeper] = active;
        emit KeeperUpdated(keeper, active);
    }
}
