// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — Accounting
//  Dual-asset TVL tracking, gain splitting, and loss waterfall
//  See: docs/PV_V3_FINAL_v34.md section 17
// ══════════════════════════════════════════════════════════════════════

import {IAccounting} from "../interfaces/IAccounting.sol";
import {TrancheId} from "../interfaces/IPrimeCDO.sol";
import {IAprPairFeed} from "../interfaces/IAprPairFeed.sol";
import {RiskParams} from "../governance/RiskParams.sol";

/**
 * @title Accounting
 * @notice Tracks per-tranche TVL for a single PrimeVaults market.
 * @dev Dual-asset: Senior + Mezzanine + Junior (base + WETH) + Reserve.
 *      Gain splitting: Senior gets target APR, Junior gets residual.
 *      Loss waterfall: WETH cover → Junior base → Mezzanine → Senior.
 *      See MATH_REFERENCE §C1-C4 for gain splitting, §D1-D4 for loss waterfall.
 */
contract Accounting is IAccounting {
    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 public constant PRECISION = 1e18;

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    IAprPairFeed public immutable i_aprFeed;
    RiskParams public immutable i_riskParams;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    uint256 public s_seniorTVL;
    uint256 public s_mezzTVL;
    uint256 public s_juniorBaseTVL;
    uint256 public s_juniorWethTVL;
    uint256 public s_reserveTVL;
    uint256 public s_lastUpdateTimestamp;
    uint256 public s_srtTargetIndex;

    address public s_primeCDO;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event CDOSet(address cdo);
    event DepositRecorded(TrancheId indexed tranche, uint256 amount);
    event WithdrawRecorded(TrancheId indexed tranche, uint256 amount);
    event FeeRecorded(TrancheId indexed tranche, uint256 feeAmount);
    event JuniorWethTVLSet(uint256 wethValueUSD);

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__Unauthorized(address caller);
    error PrimeVaults__CDOAlreadySet();
    error PrimeVaults__ZeroAddress();
    error PrimeVaults__InvalidTrancheId();

    // ═══════════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyCDO() {
        if (msg.sender != s_primeCDO) revert PrimeVaults__Unauthorized(msg.sender);
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address aprFeed_, address riskParams_) {
        i_aprFeed = IAprPairFeed(aprFeed_);
        i_riskParams = RiskParams(riskParams_);
        s_srtTargetIndex = PRECISION; // init: 1e18
        s_lastUpdateTimestamp = block.timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  SETUP
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Set the PrimeCDO address. Can only be called once.
     * @param cdo_ Address of the paired PrimeCDO contract
     */
    function setCDO(address cdo_) external {
        if (cdo_ == address(0)) revert PrimeVaults__ZeroAddress();
        if (s_primeCDO != address(0)) revert PrimeVaults__CDOAlreadySet();
        s_primeCDO = cdo_;
        emit CDOSet(cdo_);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  MUTATIVE — updateTVL (Part 2, not yet implemented)
    // ═══════════════════════════════════════════════════════════════════

    /** @dev Placeholder — implemented in Part 2 (gain splitting + loss waterfall). */
    function updateTVL(uint256, uint256) external override onlyCDO {
        // TODO: implement in Part 2
    }

    // ═══════════════════════════════════════════════════════════════════
    //  MUTATIVE — Record deposit / withdraw / fee
    // ═══════════════════════════════════════════════════════════════════

    /** @notice Record a deposit into a tranche's TVL. */
    function recordDeposit(TrancheId id, uint256 amount) external override onlyCDO {
        _addToTranche(id, amount);
        emit DepositRecorded(id, amount);
    }

    /** @notice Record a withdrawal from a tranche's TVL. */
    function recordWithdraw(TrancheId id, uint256 amount) external override onlyCDO {
        _subFromTranche(id, amount);
        emit WithdrawRecorded(id, amount);
    }

    /** @notice Record a fee — deduct from tranche, add to reserve. */
    function recordFee(TrancheId id, uint256 feeAmount) external override onlyCDO {
        _subFromTranche(id, feeAmount);
        s_reserveTVL += feeAmount;
        emit FeeRecorded(id, feeAmount);
    }

    /** @notice Directly set Junior WETH TVL (USD value). */
    function setJuniorWethTVL(uint256 wethValueUSD) external override onlyCDO {
        s_juniorWethTVL = wethValueUSD;
        emit JuniorWethTVLSet(wethValueUSD);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════════

    /** @notice Get TVL for a specific tranche. Junior returns base + WETH. */
    function getTrancheTVL(TrancheId id) external view override returns (uint256) {
        if (id == TrancheId.SENIOR) return s_seniorTVL;
        if (id == TrancheId.MEZZ) return s_mezzTVL;
        if (id == TrancheId.JUNIOR) return s_juniorBaseTVL + s_juniorWethTVL;
        revert PrimeVaults__InvalidTrancheId();
    }

    /** @notice Get total Junior TVL (base + WETH). */
    function getJuniorTVL() external view override returns (uint256) {
        return s_juniorBaseTVL + s_juniorWethTVL;
    }

    /** @notice Get Junior base asset TVL only. */
    function getJuniorBaseTVL() external view override returns (uint256) {
        return s_juniorBaseTVL;
    }

    /** @notice Get Junior WETH buffer TVL in USD. */
    function getJuniorWethTVL() external view override returns (uint256) {
        return s_juniorWethTVL;
    }

    /** @notice Get TVL for all three tranches. */
    function getAllTVLs() external view override returns (uint256 sr, uint256 mz, uint256 jr) {
        sr = s_seniorTVL;
        mz = s_mezzTVL;
        jr = s_juniorBaseTVL + s_juniorWethTVL;
    }

    /** @dev Placeholder — implemented in Part 2 (_computeSeniorAPR). */
    function getSeniorAPR() external view override returns (uint256) {
        // TODO: implement in Part 2
        return 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    function _addToTranche(TrancheId id, uint256 amount) internal {
        if (id == TrancheId.SENIOR) s_seniorTVL += amount;
        else if (id == TrancheId.MEZZ) s_mezzTVL += amount;
        else if (id == TrancheId.JUNIOR) s_juniorBaseTVL += amount;
        else revert PrimeVaults__InvalidTrancheId();
    }

    function _subFromTranche(TrancheId id, uint256 amount) internal {
        if (id == TrancheId.SENIOR) s_seniorTVL -= amount;
        else if (id == TrancheId.MEZZ) s_mezzTVL -= amount;
        else if (id == TrancheId.JUNIOR) s_juniorBaseTVL -= amount;
        else revert PrimeVaults__InvalidTrancheId();
    }
}
