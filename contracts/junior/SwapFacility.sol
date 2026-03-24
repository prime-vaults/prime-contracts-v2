// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ══════════════════════════════════════════════════════════════════════
//  PRIMEVAULTS V3 — SwapFacility
//  WETH ↔ base asset swap facility (shared across all markets)
//  See: docs/PV_V3_FINAL_v34.md section 21
// ══════════════════════════════════════════════════════════════════════

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ISwapFacility} from "../interfaces/ISwapFacility.sol";

/**
 * @dev Minimal swap router interface (Uniswap V3-compatible).
 */
interface ISwapRouter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut) external returns (uint256 amountOut);
}

/**
 * @title SwapFacility
 * @notice WETH ↔ base asset swap facility shared across all markets.
 * @dev Used for loss coverage (sell WETH), rebalance sell, and rebalance buy.
 *      Two slippage tiers: normal (s_maxSlippage, 1%) and emergency (s_emergencySlippage, 10%).
 *      Only authorized PrimeCDOs can call swap functions.
 */
contract SwapFacility is Ownable2Step, ISwapFacility {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════

    uint256 public constant MAX_BPS = 10_000;
    uint256 private constant PRECISION = 1e18;

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    ISwapRouter public immutable i_router;
    address public immutable i_weth;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    uint256 public s_maxSlippage;       // normal: 100 = 1%
    uint256 public s_emergencySlippage; // emergency: 1000 = 10%
    mapping(address => bool) public s_authorizedCDOs;

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event WETHSwapped(address indexed outputToken, uint256 wethIn, uint256 amountOut);
    event SwappedForWETH(address indexed inputToken, uint256 amountIn, uint256 wethOut);
    event CDOAuthorized(address indexed cdo, bool authorized);
    event SlippageUpdated(uint256 maxSlippage, uint256 emergencySlippage);

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__Unauthorized(address caller);
    error PrimeVaults__SlippageExceeded(uint256 amountOut, uint256 minOut);
    error PrimeVaults__InvalidSlippage();

    // ═══════════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════════

    modifier onlyAuthorizedCDO() {
        if (!s_authorizedCDOs[msg.sender]) revert PrimeVaults__Unauthorized(msg.sender);
        _;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════

    constructor(address router_, address weth_, address owner_) Ownable(owner_) {
        i_router = ISwapRouter(router_);
        i_weth = weth_;
        s_maxSlippage = 100;       // 1%
        s_emergencySlippage = 1000; // 10%
    }

    // ═══════════════════════════════════════════════════════════════════
    //  MUTATIVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Swap WETH for a base asset via DEX.
     * @dev Transfers WETH from caller, executes swap, returns output to caller.
     */
    function swapWETHFor(address outputToken, uint256 wethAmount, uint256 minOut) external override onlyAuthorizedCDO returns (uint256 amountOut) {
        IERC20(i_weth).safeTransferFrom(msg.sender, address(this), wethAmount);
        IERC20(i_weth).approve(address(i_router), wethAmount);

        amountOut = i_router.swap(i_weth, outputToken, wethAmount, minOut);
        if (amountOut < minOut) revert PrimeVaults__SlippageExceeded(amountOut, minOut);

        IERC20(outputToken).safeTransfer(msg.sender, amountOut);

        emit WETHSwapped(outputToken, wethAmount, amountOut);
    }

    /**
     * @notice Swap a base asset for WETH via DEX.
     * @dev Transfers inputToken from caller, executes swap, returns WETH to caller.
     */
    function swapForWETH(address inputToken, uint256 amount, uint256 minWethOut) external override onlyAuthorizedCDO returns (uint256 wethOut) {
        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(inputToken).approve(address(i_router), amount);

        wethOut = i_router.swap(inputToken, i_weth, amount, minWethOut);
        if (wethOut < minWethOut) revert PrimeVaults__SlippageExceeded(wethOut, minWethOut);

        IERC20(i_weth).safeTransfer(msg.sender, wethOut);

        emit SwappedForWETH(inputToken, amount, wethOut);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Calculate minimum acceptable output for a WETH swap.
     * @dev Normal mode: (1 - s_maxSlippage/10000) × wethAmount × wethPrice / 1e18
     *      Emergency mode: (1 - s_emergencySlippage/10000) × wethAmount × wethPrice / 1e18
     */
    function getMinOutput(uint256 wethAmount, uint256 wethPrice, bool isEmergency) external view override returns (uint256 minOut) {
        uint256 slippage = isEmergency ? s_emergencySlippage : s_maxSlippage;
        uint256 grossOut = wethAmount * wethPrice / PRECISION;
        minOut = grossOut * (MAX_BPS - slippage) / MAX_BPS;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Authorize or deauthorize a PrimeCDO to use swap functions.
     */
    function setAuthorizedCDO(address cdo, bool authorized) external onlyOwner {
        s_authorizedCDOs[cdo] = authorized;
        emit CDOAuthorized(cdo, authorized);
    }

    /**
     * @notice Update slippage parameters.
     */
    function setSlippage(uint256 maxSlippage_, uint256 emergencySlippage_) external onlyOwner {
        if (maxSlippage_ > MAX_BPS || emergencySlippage_ > MAX_BPS) revert PrimeVaults__InvalidSlippage();
        s_maxSlippage = maxSlippage_;
        s_emergencySlippage = emergencySlippage_;
        emit SlippageUpdated(maxSlippage_, emergencySlippage_);
    }
}
