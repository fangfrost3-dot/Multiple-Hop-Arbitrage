import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const FlashLoanExecutorModule = buildModule("FlashLoanExecutorModule", (m) => {
  const lender = m.getParameter("lender");
  const executor = m.contract("FlashLoanExecutor", [lender]);

  return { executor };
});

export default FlashLoanExecutorModule;
