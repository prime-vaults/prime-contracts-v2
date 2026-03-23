// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Mock Aave v3 Pool that returns configurable currentLiquidityRate per asset.
 *      Rates are set in ray (1e27) to match real Aave behavior.
 */
contract MockAavePool {
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

    mapping(address => uint128) private _rates; // ray scale

    function setLiquidityRate(address asset, uint128 rateRay) external {
        _rates[asset] = rateRay;
    }

    function getReserveData(address asset) external view returns (ReserveData memory data) {
        data.currentLiquidityRate = _rates[asset];
    }
}

/**
 * @dev Mock aToken with configurable totalSupply (simulates Aave supply balance).
 */
contract MockAToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
