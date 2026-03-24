// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — SUSDaiStrategy
//  Strategy adapter for sUSDai (ERC-4626 deposit + ERC-7540 async redeem)
//  See: docs/PV_V3_APR_ORACLE.md section 9
// ══════════════════════════════════════════════════════════════════════

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {WithdrawResult, WithdrawType} from "../../interfaces/IStrategy.sol";
import {BaseStrategy} from "../BaseStrategy.sol";

/**
 * @dev Minimal sUSDai interface — ERC-4626 deposit + ERC-7540 async redeem.
 */
interface ISUSDai {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function convertToShares(uint256 assets) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function requestRedeem(uint256 shares, address receiver, address owner) external returns (uint256 requestId);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/**
 * @title SUSDaiStrategy
 * @notice Strategy adapter for USD.AI sUSDai vault on Arbitrum.
 * @dev Deposit: USDai → sUSDai.deposit() (synchronous, ERC-4626).
 *      Deposit sUSDai directly: just holds it (already yield-bearing).
 *      Withdraw sUSDai: instant transfer (WithdrawType.INSTANT).
 *      Withdraw USDai: sUSDai.requestRedeem() → ~7 day cooldown (WithdrawType.UNSTAKE).
 *      totalAssets: sUSDai balance × convertToAssets rate.
 *      sUSDai: 0x0B2b2B2076d95dda7817e785989fE353fe955ef9 (Arbitrum)
 *      USDai:  0x0A1a1A107E45b7Ced86833863f482BC5f4ed82EF (Arbitrum)
 */
contract SUSDaiStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    ISUSDai public immutable i_sUSDai;

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @param primeCDO_ Paired PrimeCDO address
     * @param usdai_ USDai base asset address
     * @param sUSDai_ sUSDai vault address
     * @param owner_ Contract owner (governance)
     */
    constructor(address primeCDO_, address usdai_, address sUSDai_, address owner_) BaseStrategy(primeCDO_, usdai_, owner_) {
        i_sUSDai = ISUSDai(sUSDai_);
        // Approve sUSDai vault to spend USDai for deposits
        IERC20(usdai_).approve(sUSDai_, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  IStrategy — VIEW
    // ═══════════════════════════════════════════════════════════════════

    /** @notice Total base-equivalent value: sUSDai balance converted to USDai. */
    function totalAssets() external view override returns (uint256) {
        uint256 shares = i_sUSDai.balanceOf(address(this));
        return i_sUSDai.convertToAssets(shares);
    }

    /** @notice Supported deposit tokens: [USDai, sUSDai]. */
    function supportedTokens() external view override returns (address[] memory tokens) {
        tokens = new address[](2);
        tokens[0] = i_baseAsset;
        tokens[1] = address(i_sUSDai);
    }

    /**
     * @notice Predict withdrawal type for a given output token.
     * @dev sUSDai → INSTANT (direct transfer). USDai → UNSTAKE (ERC-7540 async).
     */
    function predictWithdrawType(address outputToken) external view override returns (WithdrawType) {
        if (outputToken == address(i_sUSDai)) return WithdrawType.INSTANT;
        if (outputToken == i_baseAsset) return WithdrawType.UNSTAKE;
        revert PrimeVaults__UnsupportedToken(outputToken);
    }

    /** @notice Cooldown handlers — none managed directly (CDO handles cooldown routing). */
    function getCooldownHandlers() external pure override returns (address[] memory) {
        return new address[](0);
    }

    /** @notice Strategy name. */
    function name() external pure override returns (string memory) {
        return "PrimeVaults sUSDai Strategy";
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL — deposit
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Deposit USDai → sUSDai via ERC-4626 deposit (synchronous).
     */
    function _deposit(uint256 amount) internal override returns (uint256 shares) {
        shares = i_sUSDai.deposit(amount, address(this));
    }

    /**
     * @dev Deposit a supported token.
     *      USDai → sUSDai.deposit(). sUSDai → just hold it (already yield-bearing).
     */
    function _depositToken(address token, uint256 amount) internal override returns (uint256 shares) {
        if (token == i_baseAsset) {
            shares = i_sUSDai.deposit(amount, address(this));
        } else if (token == address(i_sUSDai)) {
            // sUSDai deposited directly — already here from safeTransferFrom in BaseStrategy
            shares = amount; // 1:1 share accounting
        } else {
            revert PrimeVaults__UnsupportedToken(token);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL — withdraw
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Withdraw logic based on output token:
     *      sUSDai → instant transfer (no cooldown).
     *      USDai → ERC-7540 requestRedeem (async, ~7 days).
     */
    function _withdraw(uint256 amount, address outputToken, address beneficiary) internal override returns (WithdrawResult memory result) {
        if (outputToken == address(i_sUSDai)) {
            // Instant: transfer sUSDai directly
            uint256 shares = i_sUSDai.convertToShares(amount);
            i_sUSDai.transfer(beneficiary, shares);
            result = WithdrawResult({
                wType: WithdrawType.INSTANT,
                amountOut: shares,
                cooldownId: 0,
                cooldownHandler: address(0),
                unlockTime: 0
            });
            emit Withdrawn(outputToken, amount, shares);
        } else if (outputToken == i_baseAsset) {
            // Unstake: ERC-7540 async redeem
            uint256 shares = i_sUSDai.convertToShares(amount);
            uint256 requestId = i_sUSDai.requestRedeem(shares, beneficiary, address(this));
            result = WithdrawResult({
                wType: WithdrawType.UNSTAKE,
                amountOut: 0,
                cooldownId: requestId,
                cooldownHandler: address(i_sUSDai),
                unlockTime: block.timestamp + 7 days
            });
            emit Withdrawn(outputToken, amount, shares);
        } else {
            revert PrimeVaults__UnsupportedToken(outputToken);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL — emergency
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Emergency: transfer all sUSDai back to CDO (no redeem, instant).
     */
    function _emergencyWithdraw() internal override returns (uint256 amountOut) {
        uint256 shares = i_sUSDai.balanceOf(address(this));
        amountOut = i_sUSDai.convertToAssets(shares);
        i_sUSDai.transfer(i_primeCDO, shares);
    }

    function _isSupported(address token) internal view override returns (bool) {
        return token == i_baseAsset || token == address(i_sUSDai);
    }
}
