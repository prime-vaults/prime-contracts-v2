// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Mock WETH (mintable ERC20).
 */
contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @dev Mock Aave v3 Pool for AaveWETHAdapter testing.
 *      supply() transfers WETH from caller, mints aWETH 1:1.
 *      withdraw() burns aWETH, transfers WETH to recipient.
 *      getReserveData() returns configurable currentLiquidityRate + aTokenAddress.
 */
contract MockAavePoolForAdapter {
    struct ReserveData {
        uint256 configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    MockAWETH public immutable aWeth;
    address public immutable weth;
    uint128 private _rate; // ray

    constructor(address weth_) {
        weth = weth_;
        aWeth = new MockAWETH();
        _rate = 25_000_000_000_000_000_000_000_000; // 2.5% in ray
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(asset == weth, "wrong asset");
        IERC20(weth).transferFrom(msg.sender, address(this), amount);
        aWeth.mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(asset == weth, "wrong asset");
        // type(uint256).max means withdraw all
        uint256 withdrawAmount = amount == type(uint256).max ? aWeth.balanceOf(msg.sender) : amount;
        aWeth.burn(msg.sender, withdrawAmount);
        IERC20(weth).transfer(to, withdrawAmount);
        return withdrawAmount;
    }

    function getReserveData(address) external view returns (ReserveData memory data) {
        data.currentLiquidityRate = _rate;
        data.aTokenAddress = address(aWeth);
    }

    function setLiquidityRate(uint128 rate_) external {
        _rate = rate_;
    }

    /** @dev Simulate yield: mint extra aWETH to holder + add WETH to pool. */
    function simulateYield(address holder, uint256 yieldAmount) external {
        aWeth.mint(holder, yieldAmount);
        MockWETH(weth).mint(address(this), yieldAmount);
    }
}

/**
 * @dev Mock aWETH — simple mintable/burnable ERC20.
 */
contract MockAWETH is ERC20 {
    constructor() ERC20("Aave WETH", "aWETH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
