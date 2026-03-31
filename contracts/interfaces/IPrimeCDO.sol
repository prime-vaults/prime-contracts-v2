// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — IPrimeCDO
//  Core orchestrator interface (1 CDO = 1 Strategy)
//  See: docs/PV_V3_FINAL_v34.md section 18
// ══════════════════════════════════════════════════════════════════════

/** @notice Identifies which tranche a vault belongs to */
enum TrancheId {
    SENIOR,
    MEZZ,
    JUNIOR
}

/** @notice Cooldown mechanism applied to a withdrawal */
enum CooldownType {
    NONE,         // 0 — instant withdrawal
    ASSETS_LOCK,  // 1 — sUSDai/WETH locked in ERC20Cooldown
    SHARES_LOCK   // 2 — vault shares escrowed in SharesCooldown
}

/** @notice Result returned by CDO withdrawal operations */
struct CDOWithdrawResult {
    bool isInstant;
    uint256 amountOut;
    uint256 cooldownId;
    address cooldownHandler;
    uint256 unlockTime;
    uint256 feeAmount;
    CooldownType appliedCooldownType;
    uint256 wethAmount;
    uint256 wethCooldownId;
}

/**
 * @title IPrimeCDO
 * @notice Interface for the PrimeCDO orchestrator contract
 * @dev Core contract connecting TrancheVaults to a single Strategy via Accounting.
 *      Handles deposit routing, withdrawal with coverage gates, Junior dual-asset
 *      management, WETH loss coverage, and asymmetric rebalancing.
 */
interface IPrimeCDO {
    // ═══════════════════════════════════════════════════════════════════
    //  DEPOSIT
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Deposit base asset into a Senior or Mezzanine tranche
     * @dev Only callable by the registered TrancheVault for the given tranche.
     *      Updates accounting, routes tokens directly to strategy, records deposit.
     *      Reverts if coverage < 105% for Senior/Mezz (coverage gate).
     *      Reverts if protocol is shortfall-paused.
     * @param tranche Target tranche (SENIOR or MEZZ — Junior uses depositJunior)
     * @param token Deposit token address (must be in strategy.supportedTokens())
     * @param amount Token amount to deposit
     * @return baseAmount Base-asset-equivalent value deposited (used for share calculation)
     */
    function deposit(TrancheId tranche, address token, uint256 amount) external returns (uint256 baseAmount);

    /**
     * @notice Deposit dual-asset (base + WETH) into the Junior tranche
     * @dev Only callable by the Junior TrancheVault. Validates WETH ratio is within
     *      [target - tolerance, target + tolerance]. Routes base to strategy, WETH to Aave.
     * @param baseToken Base asset token address
     * @param baseAmount Amount of base asset to deposit
     * @param wethAmount Amount of WETH to deposit (goes to AaveWETHAdapter)
     * @param depositor Address of the original depositor
     * @return totalBaseValue Total base-equivalent value of the deposit (base + WETH USD value)
     */
    function depositJunior(address baseToken, uint256 baseAmount, uint256 wethAmount, address depositor) external returns (uint256 totalBaseValue);

    // ═══════════════════════════════════════════════════════════════════
    //  WITHDRAW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Request withdrawal from a Senior or Mezzanine tranche
     * @dev Only callable by the registered TrancheVault. Queries RedemptionPolicy for
     *      cooldown type, applies fees if any, routes through appropriate cooldown handler.
     *      Always withdraws the underlying yield token (sUSDai) — no outputToken selection.
     *      See docs/PV_V3_COVERAGE_GATE.md for coverage-dependent mechanism selection.
     * @param tranche Tranche to withdraw from (SENIOR or MEZZ)
     * @param baseAmount Base-equivalent amount to withdraw
     * @param beneficiary Address that will receive withdrawn tokens
     * @param vaultShares Vault shares being redeemed (for SharesLock accounting)
     * @return result Struct with withdrawal outcome, cooldown details, and fees
     */
    function requestWithdraw(TrancheId tranche, uint256 baseAmount, address beneficiary, uint256 vaultShares) external returns (CDOWithdrawResult memory result);

    /**
     * @notice Withdraw from Junior tranche (proportional base + WETH)
     * @dev Only callable by the Junior TrancheVault. WETH portion is always instant
     *      (withdrawn from Aave). Base portion goes through cooldown flow.
     *      Always withdraws the underlying yield token (sUSDai) — no outputToken selection.
     *      See docs/PV_V3_FINAL_v34.md section 42 for Junior withdrawal flow.
     * @param baseAmount Base-equivalent amount of the base portion
     * @param beneficiary Address that will receive withdrawn tokens
     * @param vaultShares Vault shares being redeemed
     * @param totalJuniorShares Total supply of Junior vault shares (for proportional WETH calc)
     * @return result Struct with withdrawal outcome, cooldown details, and fees
     */
    function withdrawJunior(uint256 baseAmount, address beneficiary, uint256 vaultShares, uint256 totalJuniorShares) external returns (CDOWithdrawResult memory result);

    /**
     * @notice Claim a completed ERC20Cooldown (ASSETS_LOCK) withdrawal
     * @dev Callable by anyone (beneficiary or on their behalf).
     * @param cooldownId The cooldown request ID to claim
     * @param cooldownHandler Address of the cooldown handler contract holding the request
     * @return amountOut Amount of tokens transferred to the beneficiary
     */
    function claimWithdraw(uint256 cooldownId, address cooldownHandler) external returns (uint256 amountOut);

    /**
     * @notice Claim a completed SharesCooldown (SHARES_LOCK) withdrawal
     * @dev Callable by anyone. Claims shares from SharesCooldown → CDO receives shares →
     *      CDO converts to base amount at current exchange rate → withdraws from strategy → sends to beneficiary.
     *      User benefits from yield accrued during the cooldown period.
     *      Always withdraws the underlying yield token (sUSDai).
     * @param cooldownId The SharesCooldown request ID to claim
     * @return amountOut Amount of sUSDai transferred to the beneficiary
     */
    function claimSharesWithdraw(uint256 cooldownId) external returns (uint256 amountOut);

    // ═══════════════════════════════════════════════════════════════════
    //  REBALANCE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Sell excess WETH when ETH price rises above target ratio + tolerance
     * @dev Permissionless — anyone can call. Cannot extract value.
     *      Withdraws WETH from Aave → swaps to base asset → deposits into strategy.
     *      See docs/PV_V3_FINAL_v34.md section 12 for asymmetric rebalance design.
     */
    function rebalanceSellWETH() external;

    /**
     * @notice Buy WETH when ETH price drops below target ratio - tolerance
     * @dev Governance-only with timelock. Recalls base from strategy → swaps to WETH → supplies Aave.
     * @param maxBaseToRecall Maximum base asset amount to recall from strategy for the swap
     */
    function rebalanceBuyWETH(uint256 maxBaseToRecall) external;

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Address of the Accounting contract for this market
     * @return The Accounting contract address
     */
    function accounting() external view returns (address);

    /**
     * @notice Address of the Strategy contract for this market
     * @return The Strategy contract address
     */
    function strategy() external view returns (address);
}
