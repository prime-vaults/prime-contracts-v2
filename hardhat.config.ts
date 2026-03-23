import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-gas-reporter";
import "solidity-coverage";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      // Fork mainnet for integration tests
      // forking: {
      //   url: process.env.MAINNET_RPC_URL || "",
      // },
    },
  },
  gasReporter: {
    enabled: true,
  },
};

export default config;
