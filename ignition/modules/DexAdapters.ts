import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const DexAdaptersModule = buildModule("DexAdaptersModule", (m) => {
  const v2Adapter = m.contract("UniswapV2Adapter", []);
  const v3Adapter = m.contract("UniswapV3Adapter", []);
  const oneInchAdapter = m.contract("OneInchAdapter", []);

  return { v2Adapter, v3Adapter, oneInchAdapter };
});

export default DexAdaptersModule;
