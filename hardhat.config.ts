import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-gas-reporter";
import "solidity-coverage";
import "dotenv/config";

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
      // Fork Arbitrum for integration tests / deploy verification:
      // ARB_RPC_URL=<url> npx hardhat test test/integration/
      ...(process.env.ARB_RPC_URL
        ? {
            forking: {
              url: process.env.ARB_RPC_URL,
            },
          }
        : {}),
    },
    arbitrum: {
      url: process.env.ARB_RPC_URL || "",
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
      chainId: 42161,
    },
  },
  gasReporter: {
    enabled: true,
  },
};

export default config;
