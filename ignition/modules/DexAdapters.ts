import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const DexAdaptersModule = buildModule("DexAdaptersModule", (m) => {
  const v2Adapter = m.contract("UniswapV2Adapter", []);
  const v3Adapter = m.contract("UniswapV3Adapter", []);

  return { v2Adapter, v3Adapter };
});

export default DexAdaptersModule;
