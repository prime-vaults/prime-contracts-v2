// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — AprPairFeed
//  Aggregates benchmark APR (Aave) + strategy APR (sUSDai) from providers
//  See: docs/PV_V3_APR_ORACLE.md section 4
// ══════════════════════════════════════════════════════════════════════

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IAprFeed} from "../interfaces/IAprFeed.sol";
import {AaveAprProvider} from "./providers/AaveAprProvider.sol";
import {SUSDaiAprProvider} from "./providers/SUSDaiAprProvider.sol";

/**
 * @title AprPairFeed
 * @notice Aggregates benchmark APR (Aave) + strategy APR (sUSDai) from on-chain providers.
 * @dev Replaces manual setAprPair. Both values fully on-chain.
 *      updateRoundData() is permissionless — anyone can call (no value extraction possible).
 *      Fallback: governance can override via setManualApr() for emergencies.
 *      See docs/PV_V3_FINAL_v34.md section 29 for architecture.
 */
contract AprPairFeed is Ownable2Step, IAprFeed {
    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    AaveAprProvider public immutable i_aaveProvider;
    SUSDaiAprProvider public immutable i_susdaiProvider;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    uint256 public s_aprTarget;
    uint256 public s_aprBase;
    uint256 public s_lastUpdated;
    uint256 public s_staleAfter;

    bool public s_manualOverride;
    uint256 public s_manualAprTarget;
    uint256 public s_manualAprBase;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event ManualOverrideSet(uint256 aprTarget, uint256 aprBase);
    event ManualOverrideCleared();

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__StaleApr(uint256 lastUpdated, uint256 staleAfter);

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address aaveProvider_, address susdaiProvider_, address owner_) Ownable(owner_) {
        i_aaveProvider = AaveAprProvider(aaveProvider_);
        i_susdaiProvider = SUSDaiAprProvider(susdaiProvider_);
        s_staleAfter = 172_800; // 48 hours
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW (Accounting calls this)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Get APR pair — reverts if stale.
     * @return aprTarget Benchmark APR (Aave weighted avg), 18 decimals
     * @return aprBase Strategy APR (sUSDai yield), 18 decimals
     */
    function getAprPair() external view override returns (uint256 aprTarget, uint256 aprBase) {
        if (block.timestamp - s_lastUpdated > s_staleAfter) {
            revert PrimeVaults__StaleApr(s_lastUpdated, s_staleAfter);
        }
        return (s_aprTarget, s_aprBase);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  UPDATE (permissionless — anyone can call)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Fetch fresh APR from both providers and cache.
     * @dev Permissionless — anyone can call (no value extraction possible).
     *      In manual override mode: uses manual values instead of providers.
     */
    function updateRoundData() external override {
        if (s_manualOverride) {
            s_aprTarget = s_manualAprTarget;
            s_aprBase = s_manualAprBase;
        } else {
            s_aprTarget = i_aaveProvider.fetchBenchmarkApr();
            s_aprBase = i_susdaiProvider.fetchStrategyApr();
        }

        s_lastUpdated = block.timestamp;
        emit AprUpdated(s_aprTarget, s_aprBase, block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Emergency manual override — governance sets APR directly.
     * @dev Use when: provider broken, sUSDai contract paused, first 24h after deploy.
     * @param aprTarget_ Benchmark APR (18 decimals)
     * @param aprBase_ Strategy APR (18 decimals)
     */
    function setManualApr(uint256 aprTarget_, uint256 aprBase_) external onlyOwner {
        s_manualOverride = true;
        s_manualAprTarget = aprTarget_;
        s_manualAprBase = aprBase_;
        emit ManualOverrideSet(aprTarget_, aprBase_);
    }

    /**
     * @notice Disable manual override — resume reading from providers.
     */
    function clearManualOverride() external onlyOwner {
        s_manualOverride = false;
        emit ManualOverrideCleared();
    }

    /**
     * @notice Update the staleness threshold.
     * @param staleAfter_ New staleness duration in seconds
     */
    function setStaleAfter(uint256 staleAfter_) external onlyOwner {
        s_staleAfter = staleAfter_;
    }
}
