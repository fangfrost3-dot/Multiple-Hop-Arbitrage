import { readFile } from "node:fs/promises";
import { isAddress } from "ethers";
import { z } from "zod";
const privateKeySchema = z
    .string()
    .trim()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/, "must be a 32-byte hex private key")
    .transform((value) => (value.startsWith("0x") ? value : `0x${value}`));
const addressSchema = z.string().trim().refine((value) => isAddress(value), "must be a valid address");
function blankToUndefined(value) {
    if (typeof value === "string" && value.trim() === "") {
        return undefined;
    }
    return value;
}
const optionalPrivateKeySchema = z.preprocess(blankToUndefined, privateKeySchema.optional());
const optionalUrlSchema = z.preprocess(blankToUndefined, z.string().url().optional());
const optionalPositiveIntSchema = z.preprocess(blankToUndefined, z.coerce.number().int().positive().optional());
function parseEnvBoolean(value) {
    if (typeof value !== "string") {
        return value;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "") {
        return undefined;
    }
    if (["true", "1", "yes", "y"].includes(normalized)) {
        return true;
    }
    if (["false", "0", "no", "n"].includes(normalized)) {
        return false;
    }
    return value;
}
function envBoolean(defaultValue) {
    return z.preprocess(parseEnvBoolean, z.boolean().default(defaultValue));
}
const optionalAddressSchema = z
    .string()
    .trim()
    .optional()
    .transform((value) => {
    if (!value) {
        return undefined;
    }
    return addressSchema.parse(value);
});
function hasCsvEntries(value) {
    if (!value) {
        return false;
    }
    return value
        .split(",")
        .map((entry) => entry.trim())
        .some((entry) => entry.length > 0);
}
export const configSchema = z.object({
    RUST_BINARY: z.string().default("../rust-core/target/release/rust-core"),
    RPC_URL: z.string().optional(),
    PRIVATE_RELAY_RPC_URL: z.string().optional(),
    EXECUTOR_SUBMISSION_MODE: z.enum(["public_only", "relay_preferred", "relay_only"]).default("public_only"),
    EXECUTOR_ALLOW_PUBLIC_MEMPOOL: envBoolean(false),
    WS_RPC_URL: z.string().optional(),
    MULTICALL3_ADDRESS: z.string().optional(),
    ARBITRUM_NODE_INTERFACE_ADDRESS: optionalAddressSchema.default("0x00000000000000000000000000000000000000C8"),
    ARBITRUM_L1_FEE_PADDING_BPS: z.coerce.number().int().nonnegative().default(1_500),
    POOL_CONFIG_PATH: z.string().default("./config/pools.example.json"),
    ROUTE_CONFIG_PATH: z.string().default("./config/routes.example.json"),
    ONE_INCH_API_KEY: z.string().optional(),
    ONE_INCH_API_BASE_URL: z.string().default("https://api.1inch.dev"),
    CANDIDATE_NOTIFICATION_WEBHOOK_URL: optionalUrlSchema,
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),
    TELEGRAM_MESSAGE_THREAD_ID: optionalPositiveIntSchema,
    ERROR_ALERTS_ENABLED: envBoolean(true),
    ERROR_ALERT_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(300_000),
    ERROR_ALERT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    CANDIDATE_NOTIFICATION_MIN_EXPECTED_PROFIT: z.coerce.bigint().default(0n),
    CANDIDATE_NOTIFICATION_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(0),
    CANDIDATE_NOTIFICATION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    RPC_MONITOR_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
    RPC_MONITOR_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    WS_PORT: z.coerce.number().default(8080),
    METRICS_PORT: z.coerce.number().int().positive().default(9090),
    STREAM_MAX_BLOCK_GAP: z.coerce.number().int().positive().default(20),
    STREAM_REORG_LOOKBACK_BLOCKS: z.coerce.number().int().positive().default(12),
    STABLE_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(0),
    V3_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(0),
    MIN_EXPECTED_PROFIT: z.coerce.bigint().default(0n),
    EXECUTOR_PRIVATE_KEY: optionalPrivateKeySchema,
    EXECUTOR_PRIVATE_KEY_PATH: z.string().optional(),
    EXECUTOR_ALLOW_INLINE_PRIVATE_KEY: envBoolean(false),
    EXECUTOR_PAPER_TRADING: envBoolean(false),
    EXECUTOR_PAPER_VALIDATE_CALL: envBoolean(true),
    EXECUTOR_VALIDATE_ROUTE_QUOTES: envBoolean(true),
    UNISWAP_V3_QUOTER_ADDRESS: optionalAddressSchema.default("0x61fFE014bA17989E743c5F6cB21bF9697530B21e"),
    EXECUTOR_PAPER_JOURNAL_PATH: z.string().default("./logs/paper_trades.jsonl"),
    EXECUTOR_CONTRACT_ADDRESS: optionalAddressSchema,
    EXECUTOR_PROFIT_RECIPIENT: optionalAddressSchema,
    EXECUTOR_JOURNAL_PATH: z.string().default("./logs/executions.jsonl"),
    EXECUTOR_OUTCOME_PATH: z.string().default("./logs/outcomes.jsonl"),
    EXECUTOR_ALLOWED_BORROW_TOKENS: z.string().optional(),
    EXECUTOR_ALLOWED_PROFIT_TOKENS: z.string().optional(),
    EXECUTOR_ALLOWED_ADAPTERS: z.string().optional(),
    EXECUTOR_ALLOWED_ROUTERS: z.string().optional(),
    EXECUTOR_ALLOWED_ROUTE_KINDS: z.string().optional(),
    EXECUTOR_BLOCKED_CYCLE_IDS: z.string().optional(),
    EXECUTOR_MAX_BORROW_AMOUNT: z.coerce.bigint().default(0n),
    EXECUTOR_MAX_ROUTE_HOPS: z.coerce.number().int().nonnegative().default(0),
    EXECUTOR_MIN_PROFIT_REALIZATION_BPS: z.coerce.number().int().min(0).max(10_000).default(0),
    EXECUTOR_MAX_PROFIT_BPS: z.coerce.number().int().nonnegative().default(0),
    EXECUTOR_START_PAUSED: envBoolean(false),
    EXECUTOR_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().nonnegative().default(3),
    EXECUTOR_MAX_TOTAL_FAILURES: z.coerce.number().int().nonnegative().default(10),
    EXECUTOR_MAX_CUMULATIVE_ESTIMATED_LOSS_WEI: z.coerce.bigint().default(0n),
    WRAPPED_NATIVE_TOKEN: optionalAddressSchema,
    MAX_GAS_COST_WEI: z.coerce.bigint().default(0n),
    EXECUTOR_CONFIRMATIONS: z.coerce.number().int().positive().default(1),
    EXECUTOR_REPLACEMENT_BUMP_BPS: z.coerce.number().int().positive().default(1_500),
    EXECUTOR_STUCK_TX_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
    EXECUTOR_MAX_REPLACEMENTS: z.coerce.number().int().nonnegative().default(3),
    EXECUTOR_MAX_INFLIGHT: z.coerce.number().int().positive().default(1),
    EXECUTOR_KILL_SWITCH_PATH: z.string().optional(),
}).superRefine((config, ctx) => {
    if (config.EXECUTOR_PROFIT_RECIPIENT && config.EXECUTOR_PRIVATE_KEY) {
        const recipientLower = config.EXECUTOR_PROFIT_RECIPIENT.toLowerCase();
        const privateKeyBody = config.EXECUTOR_PRIVATE_KEY.slice(2).toLowerCase();
        if (recipientLower === config.EXECUTOR_PRIVATE_KEY.toLowerCase() || recipientLower === privateKeyBody) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["EXECUTOR_PROFIT_RECIPIENT"],
                message: "must be a payout address, not a private key",
            });
        }
    }
    if (config.EXECUTOR_START_PAUSED) {
        return;
    }
    if (config.EXECUTOR_PAPER_TRADING) {
        return;
    }
    if (config.EXECUTOR_SUBMISSION_MODE === "relay_only" && !config.PRIVATE_RELAY_RPC_URL) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["PRIVATE_RELAY_RPC_URL"],
            message: "is required when EXECUTOR_SUBMISSION_MODE=relay_only",
        });
    }
    if (config.EXECUTOR_SUBMISSION_MODE !== "relay_only" && !config.EXECUTOR_ALLOW_PUBLIC_MEMPOOL) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["EXECUTOR_ALLOW_PUBLIC_MEMPOOL"],
            message: "must be true to use public_only or relay_preferred submission",
        });
    }
    if (!config.EXECUTOR_PRIVATE_KEY && !config.EXECUTOR_PRIVATE_KEY_PATH) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["EXECUTOR_PRIVATE_KEY"],
            message: "EXECUTOR_PRIVATE_KEY or EXECUTOR_PRIVATE_KEY_PATH is required when executor starts unpaused",
        });
    }
    if (config.EXECUTOR_PRIVATE_KEY && !config.EXECUTOR_ALLOW_INLINE_PRIVATE_KEY) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["EXECUTOR_PRIVATE_KEY"],
            message: "inline private keys are disabled by default; use EXECUTOR_PRIVATE_KEY_PATH or set EXECUTOR_ALLOW_INLINE_PRIVATE_KEY=true",
        });
    }
    const requiredFields = [
        ["EXECUTOR_CONTRACT_ADDRESS", config.EXECUTOR_CONTRACT_ADDRESS, "is required when executor starts unpaused"],
        ["EXECUTOR_PROFIT_RECIPIENT", config.EXECUTOR_PROFIT_RECIPIENT, "is required when executor starts unpaused"],
        ["WRAPPED_NATIVE_TOKEN", config.WRAPPED_NATIVE_TOKEN, "is required when executor starts unpaused"],
    ];
    for (const [path, value, message] of requiredFields) {
        if (!value) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [path],
                message,
            });
        }
    }
    const requiredAllowlists = [
        ["EXECUTOR_ALLOWED_BORROW_TOKENS", config.EXECUTOR_ALLOWED_BORROW_TOKENS],
        ["EXECUTOR_ALLOWED_PROFIT_TOKENS", config.EXECUTOR_ALLOWED_PROFIT_TOKENS],
        ["EXECUTOR_ALLOWED_ADAPTERS", config.EXECUTOR_ALLOWED_ADAPTERS],
        ["EXECUTOR_ALLOWED_ROUTERS", config.EXECUTOR_ALLOWED_ROUTERS],
        ["EXECUTOR_ALLOWED_ROUTE_KINDS", config.EXECUTOR_ALLOWED_ROUTE_KINDS],
    ];
    for (const [path, value] of requiredAllowlists) {
        if (!hasCsvEntries(value)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [path],
                message: "must be set to a non-empty allowlist when executor starts unpaused",
            });
        }
    }
    if (config.EXECUTOR_MAX_BORROW_AMOUNT <= 0n) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["EXECUTOR_MAX_BORROW_AMOUNT"],
            message: "must be greater than zero when executor starts unpaused",
        });
    }
    if (config.EXECUTOR_MAX_ROUTE_HOPS <= 0) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["EXECUTOR_MAX_ROUTE_HOPS"],
            message: "must be greater than zero when executor starts unpaused",
        });
    }
    if (config.MAX_GAS_COST_WEI <= 0n) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["MAX_GAS_COST_WEI"],
            message: "must be greater than zero when executor starts unpaused",
        });
    }
    if (config.EXECUTOR_MAX_CUMULATIVE_ESTIMATED_LOSS_WEI <= 0n) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["EXECUTOR_MAX_CUMULATIVE_ESTIMATED_LOSS_WEI"],
            message: "must be greater than zero when executor starts unpaused",
        });
    }
});
export async function loadConfig(env) {
    const normalizedEnv = { ...env };
    if (!normalizedEnv.EXECUTOR_PRIVATE_KEY && normalizedEnv.EXECUTOR_PRIVATE_KEY_PATH) {
        const fileValue = await readFile(normalizedEnv.EXECUTOR_PRIVATE_KEY_PATH, "utf8");
        normalizedEnv.EXECUTOR_PRIVATE_KEY = fileValue.trim();
    }
    return configSchema.parse(normalizedEnv);
}
