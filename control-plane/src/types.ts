export interface PoolSnapshot {
  pool_id: string;
  dex: string;
  pool_kind: "xyk" | "stable";
  amp_factor?: number;
  sqrt_price_x96?: string;
  liquidity?: string;
  token_in: string;
  token_out: string;
  reserve_in: string;
  reserve_out: string;
  fee_bps: number;
}

export interface PoolUpdate {
  pool_id: string;
  reserve_in: string;
  reserve_out: string;
  block_number: number;
  log_index?: number;
  sqrt_price_x96?: string;
  liquidity?: string;
  source?: "live" | "recovery" | "reconnect_recovery" | "reorg_recovery";
  replay_from_block?: number;
  replay_to_block?: number;
}

export interface ExecutionCandidate {
  cycle_id: string;
  borrow_token: string;
  borrow_amount: string;
  gross_output: string;
  expected_profit: string;
  touched_pools: string[];
}

export interface ExecutionRecord {
  cycleId: string;
  txHash: string;
  nonce: number;
  submittedAt: number;
  lastBroadcastAt: number;
  replacementCount: number;
  submissionTarget: "public" | "relay";
  borrowToken: string;
  borrowAmount: string;
  expectedProfit: string;
  profitToken: string;
  profitRecipient: string;
  profitRecipientBalanceBefore?: string;
  routeHops: number;
  gasLimit: string;
  estimatedGasCostWei?: string;
  estimatedL2GasCostWei?: string;
  estimatedL1CalldataFeeWei?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
}

export interface ExecutionJournalEntry {
  timestamp: number;
  event: "risk_rejected" | "submitted" | "confirmed" | "reverted" | "dropped" | "replaced" | "paused" | "resumed";
  cycleId: string;
  txHash?: string;
  nonce?: number;
  reason?: string;
  borrowToken?: string;
  borrowAmount?: string;
  expectedProfit?: string;
  routeHops?: number;
  details?: Record<string, string | number | boolean | undefined>;
}

export interface ExecutionOutcomeEntry {
  timestamp: number;
  cycleId: string;
  txHash?: string;
  nonce?: number;
  status: "confirmed" | "reverted" | "dropped";
  submissionTarget?: "public" | "relay";
  borrowToken: string;
  borrowAmount: string;
  expectedProfit: string;
  routeHops: number;
  blockNumber?: number;
  gasUsed?: string;
  txCostWei?: string;
  estimatedNetProfitWei?: string;
  realizedProfitTokenDelta?: string;
  cumulativeEstimatedNetWei?: string;
}

export interface ExecutorMetrics {
  submitted: number;
  submittedPublic: number;
  submittedRelay: number;
  confirmed: number;
  reverted: number;
  dropped: number;
  replaced: number;
  riskRejected: number;
  consecutiveFailures: number;
  totalFailures: number;
  inflight: number;
}

export interface ExecutorStatus {
  paused: boolean;
  pauseReason?: string;
  metrics: ExecutorMetrics;
  cumulativeEstimatedNetWei: string;
}

export interface V2PoolConfig {
  kind: "v2";
  poolId: string;
  dex: string;
  pair: string;
  tokenIn: string;
  tokenOut: string;
  feeBps: number;
}

export interface V2FactoryConfig {
  kind: "v2_factory";
  dex: string;
  factory: string;
  tokens: string[];
  feeBps: number;
}

export interface StablePoolConfig {
  kind: "stable";
  poolId: string;
  dex: string;
  poolAddress?: string;
  handler?: "curve_two_coin";
  tokenIn: string;
  tokenOut: string;
  reserveIn: string;
  reserveOut: string;
  feeBps: number;
  ampFactor: number;
}

export interface V3PoolConfig {
  kind: "v3";
  poolId: string;
  dex: string;
  poolAddress: string;
  handler?: "uniswap_v3";
  tokenIn: string;
  tokenOut: string;
  feeBps: number;
}

export type PoolConfig = V2PoolConfig | V2FactoryConfig | StablePoolConfig | V3PoolConfig;

export interface V2RouteConfig {
  kind: "v2";
  adapter: string;
  tokenIn: string;
  tokenOut: string;
  router: string;
  path: string[];
  amountOutMin: string;
  deadlineSeconds: number;
}

export interface V3RouteConfig {
  kind: "v3";
  adapter: string;
  tokenIn: string;
  tokenOut: string;
  router: string;
  fee: number;
  amountOutMin: string;
  deadlineSeconds: number;
  sqrtPriceLimitX96: string;
}

export interface OneInchRouteConfig {
  kind: "one_inch";
  adapter: string;
  tokenIn: string;
  tokenOut: string;
  router: string;
  chainId: number;
  slippageBps: number;
  protocols?: string[];
  referrerAddress?: string;
  complexityLevel?: number;
  disableEstimate?: boolean;
  allowPartialFill?: boolean;
  includeTokensInfo?: boolean;
  includeProtocols?: boolean;
  includeGas?: boolean;
}

export type SwapRouteConfig = V2RouteConfig | V3RouteConfig | OneInchRouteConfig;

export interface ExecutionRouteConfig {
  cycleId: string;
  borrowToken: string;
  profitToken: string;
  minProfit: string;
  swaps: SwapRouteConfig[];
}
