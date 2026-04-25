import { z } from "zod";

export const configSchema = z.object({
  RUST_BINARY: z.string().default("../rust-core/target/release/rust-core"),
  RPC_URL: z.string().optional(),
  PRIVATE_RELAY_RPC_URL: z.string().optional(),
  EXECUTOR_SUBMISSION_MODE: z.enum(["public_only", "relay_preferred", "relay_only"]).default("public_only"),
  WS_RPC_URL: z.string().optional(),
  MULTICALL3_ADDRESS: z.string().optional(),
  POOL_CONFIG_PATH: z.string().default("./config/pools.example.json"),
  ROUTE_CONFIG_PATH: z.string().default("./config/routes.example.json"),
  WS_PORT: z.coerce.number().default(8080),
  METRICS_PORT: z.coerce.number().int().positive().default(9090),
  STREAM_MAX_BLOCK_GAP: z.coerce.number().int().positive().default(20),
  MIN_EXPECTED_PROFIT: z.coerce.bigint().default(0n),
  EXECUTOR_PRIVATE_KEY: z.string().optional(),
  EXECUTOR_CONTRACT_ADDRESS: z.string().optional(),
  EXECUTOR_PROFIT_RECIPIENT: z.string().optional(),
  EXECUTOR_JOURNAL_PATH: z.string().default("./logs/executions.jsonl"),
  EXECUTOR_OUTCOME_PATH: z.string().default("./logs/outcomes.jsonl"),
  EXECUTOR_ALLOWED_BORROW_TOKENS: z.string().optional(),
  EXECUTOR_ALLOWED_PROFIT_TOKENS: z.string().optional(),
  EXECUTOR_ALLOWED_ADAPTERS: z.string().optional(),
  EXECUTOR_ALLOWED_ROUTERS: z.string().optional(),
  EXECUTOR_ALLOWED_ROUTE_KINDS: z.string().optional(),
  EXECUTOR_MAX_BORROW_AMOUNT: z.coerce.bigint().default(0n),
  EXECUTOR_MAX_ROUTE_HOPS: z.coerce.number().int().nonnegative().default(0),
  EXECUTOR_START_PAUSED: z.coerce.boolean().default(false),
  EXECUTOR_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().nonnegative().default(3),
  EXECUTOR_MAX_TOTAL_FAILURES: z.coerce.number().int().nonnegative().default(10),
  EXECUTOR_MAX_CUMULATIVE_ESTIMATED_LOSS_WEI: z.coerce.bigint().default(0n),
  WRAPPED_NATIVE_TOKEN: z.string().optional(),
  MAX_GAS_COST_WEI: z.coerce.bigint().default(0n),
  EXECUTOR_CONFIRMATIONS: z.coerce.number().int().positive().default(1),
  EXECUTOR_REPLACEMENT_BUMP_BPS: z.coerce.number().int().positive().default(1_500),
  EXECUTOR_MAX_INFLIGHT: z.coerce.number().int().positive().default(1),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return configSchema.parse(env);
}
