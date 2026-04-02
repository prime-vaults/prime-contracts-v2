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
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {IQuoterV2} from "../interfaces/IQuoterV2.sol";

/**
 * @title SwapFacility
 * @notice WETH ↔ base asset swap facility shared across all markets.
 * @dev Used for loss coverage (sell WETH), rebalance sell, and rebalance buy.
 *      Swaps via Uniswap V3 exactInputSingle with configurable pool fee per token.
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
    uint24 public constant DEFAULT_POOL_FEE = 3000; // 0.3%

    // ═══════════════════════════════════════════════════════════════════
    //  IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════

    ISwapRouter public immutable i_router;
    IQuoterV2 public immutable i_quoter;
    address public immutable i_weth;

    // ═══════════════════════════════════════════════════════════════════
    //  STATE
    // ═══════════════════════════════════════════════════════════════════

    uint256 public s_maxSlippage;       // normal: 100 = 1%
    uint256 public s_emergencySlippage; // emergency: 1000 = 10%
    mapping(address => bool) public s_authorizedCDOs;
    mapping(address => uint24) public s_poolFees; // token → Uniswap V3 fee tier (0 = use DEFAULT_POOL_FEE)

    // ═══════════════════════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════════════════════

    event WETHSwapped(address indexed outputToken, uint256 wethIn, uint256 amountOut);
    event SwappedForWETH(address indexed inputToken, uint256 amountIn, uint256 wethOut);
    event CDOAuthorized(address indexed cdo, bool authorized);
    event SlippageUpdated(uint256 maxSlippage, uint256 emergencySlippage);
    event PoolFeeUpdated(address indexed token, uint24 fee);

    // ═══════════════════════════════════════════════════════════════════
    //  ERRORS
    // ═══════════════════════════════════════════════════════════════════

    error PrimeVaults__Unauthorized(address caller);
    error PrimeVaults__SlippageExceeded(uint256 amountOut, uint256 minOut);
    error PrimeVaults__InvalidSlippage();
    error PrimeVaults__InvalidPoolFee();

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

    constructor(address router_, address quoter_, address weth_, address owner_) Ownable(owner_) {
        i_router = ISwapRouter(router_);
        i_quoter = IQuoterV2(quoter_);
        i_weth = weth_;
        s_maxSlippage = 100;       // 1%
        s_emergencySlippage = 1000; // 10%
    }

    // ═══════════════════════════════════════════════════════════════════
    //  MUTATIVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Swap WETH for a base asset via Uniswap V3.
     * @dev Transfers WETH from caller, executes exactInputSingle, returns output to caller.
     *      Uses the configured pool fee for outputToken (defaults to 0.3% if not set).
     * @param outputToken Address of the base asset to receive
     * @param wethAmount Amount of WETH to sell
     * @param minOut Minimum output amount (slippage protection)
     * @return amountOut Actual amount of outputToken received
     */
    function swapWETHFor(address outputToken, uint256 wethAmount, uint256 minOut) external override onlyAuthorizedCDO returns (uint256 amountOut) {
        IERC20(i_weth).safeTransferFrom(msg.sender, address(this), wethAmount);
        IERC20(i_weth).forceApprove(address(i_router), wethAmount);

        amountOut = i_router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: i_weth,
                tokenOut: outputToken,
                fee: _getPoolFee(outputToken),
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: wethAmount,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );

        IERC20(outputToken).safeTransfer(msg.sender, amountOut);

        emit WETHSwapped(outputToken, wethAmount, amountOut);
    }

    /**
     * @notice Swap a base asset for WETH via Uniswap V3.
     * @dev Transfers inputToken from caller, executes exactInputSingle, returns WETH to caller.
     *      Uses the configured pool fee for inputToken (defaults to 0.3% if not set).
     * @param inputToken Address of the base asset to sell
     * @param amount Amount of inputToken to sell
     * @param minWethOut Minimum WETH output amount (slippage protection)
     * @return wethOut Actual amount of WETH received
     */
    function swapForWETH(address inputToken, uint256 amount, uint256 minWethOut) external override onlyAuthorizedCDO returns (uint256 wethOut) {
        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(inputToken).forceApprove(address(i_router), amount);

        wethOut = i_router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: inputToken,
                tokenOut: i_weth,
                fee: _getPoolFee(inputToken),
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amount,
                amountOutMinimum: minWethOut,
                sqrtPriceLimitX96: 0
            })
        );

        IERC20(i_weth).safeTransfer(msg.sender, wethOut);

        emit SwappedForWETH(inputToken, amount, wethOut);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Calculate minimum acceptable output for a WETH swap.
     * @dev Normal mode: (1 - s_maxSlippage/10000) x wethAmount x wethPrice / 1e18
     *      Emergency mode: (1 - s_emergencySlippage/10000) x wethAmount x wethPrice / 1e18
     *      See docs/PV_V3_MATH_REFERENCE.md section D3.
     * @param wethAmount Amount of WETH to sell
     * @param wethPrice Current WETH price in USD (18 decimals)
     * @param isEmergency true for loss coverage swaps (uses s_emergencySlippage), false for normal (uses s_maxSlippage)
     * @return minOut Minimum acceptable output amount
     */
    function getMinOutput(uint256 wethAmount, uint256 wethPrice, bool isEmergency) external view override returns (uint256 minOut) {
        uint256 slippage = isEmergency ? s_emergencySlippage : s_maxSlippage;
        uint256 grossOut = wethAmount * wethPrice / PRECISION;
        minOut = grossOut * (MAX_BPS - slippage) / MAX_BPS;
    }

    /**
     * @notice Quote how much WETH is needed to receive exactly `baseAmountOut` of a base asset.
     * @dev Uses Uniswap V3 QuoterV2. Not a pure view — QuoterV2 simulates the swap.
     * @param outputToken Address of the base asset
     * @param baseAmountOut Exact amount of base asset desired
     * @return wethNeeded Amount of WETH required
     */
    function quoteWETHForExactOutput(address outputToken, uint256 baseAmountOut)
        external
        override
        returns (uint256 wethNeeded)
    {
        (wethNeeded, , , ) = i_quoter.quoteExactOutputSingle(
            IQuoterV2.QuoteExactOutputSingleParams({
                tokenIn: i_weth,
                tokenOut: outputToken,
                amount: baseAmountOut,
                fee: _getPoolFee(outputToken),
                sqrtPriceLimitX96: 0
            })
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Authorize or deauthorize a PrimeCDO to use swap functions.
     * @param cdo Address of the PrimeCDO contract
     * @param authorized true to authorize, false to revoke
     */
    function setAuthorizedCDO(address cdo, bool authorized) external onlyOwner {
        s_authorizedCDOs[cdo] = authorized;
        emit CDOAuthorized(cdo, authorized);
    }

    /**
     * @notice Update slippage parameters.
     * @param maxSlippage_ Normal slippage in BPS (e.g. 100 = 1%)
     * @param emergencySlippage_ Emergency slippage in BPS (e.g. 1000 = 10%)
     */
    function setSlippage(uint256 maxSlippage_, uint256 emergencySlippage_) external onlyOwner {
        if (maxSlippage_ > MAX_BPS || emergencySlippage_ > MAX_BPS) revert PrimeVaults__InvalidSlippage();
        s_maxSlippage = maxSlippage_;
        s_emergencySlippage = emergencySlippage_;
        emit SlippageUpdated(maxSlippage_, emergencySlippage_);
    }

    /**
     * @notice Set the Uniswap V3 pool fee tier for a specific token pair (token ↔ WETH).
     * @dev Fee must be a valid Uniswap V3 tier: 100 (0.01%), 500 (0.05%), 3000 (0.3%), or 10000 (1%).
     *      Set to 0 to revert to DEFAULT_POOL_FEE (0.3%).
     * @param token Address of the base asset
     * @param fee Uniswap V3 fee tier in hundredths of a bip
     */
    function setPoolFee(address token, uint24 fee) external onlyOwner {
        if (fee != 0 && fee != 100 && fee != 500 && fee != 3000 && fee != 10_000) revert PrimeVaults__InvalidPoolFee();
        s_poolFees[token] = fee;
        emit PoolFeeUpdated(token, fee);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Returns the pool fee for a token, falling back to DEFAULT_POOL_FEE if not configured.
     */
    function _getPoolFee(address token) internal view returns (uint24) {
        uint24 fee = s_poolFees[token];
        return fee == 0 ? DEFAULT_POOL_FEE : fee;
    }
}
