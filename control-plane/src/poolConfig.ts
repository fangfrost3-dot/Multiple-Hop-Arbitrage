import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { PoolConfig } from "./types.js";

const v2PoolSchema = z.object({
  kind: z.literal("v2"),
  poolId: z.string(),
  dex: z.string(),
  pair: z.string(),
  tokenIn: z.string(),
  tokenOut: z.string(),
  feeBps: z.number().int().nonnegative(),
});

const v2FactorySchema = z.object({
  kind: z.literal("v2_factory"),
  dex: z.string(),
  factory: z.string(),
  tokens: z.array(z.string()).min(2),
  feeBps: z.number().int().nonnegative(),
});

const stablePoolSchema = z.object({
  kind: z.literal("stable"),
  poolId: z.string(),
  dex: z.string(),
  poolAddress: z.string().optional(),
  handler: z.literal("curve_two_coin").optional(),
  tokenIn: z.string(),
  tokenOut: z.string(),
  reserveIn: z.string(),
  reserveOut: z.string(),
  feeBps: z.number().int().nonnegative(),
  ampFactor: z.number().int().positive(),
});

const v3PoolSchema = z.object({
  kind: z.literal("v3"),
  poolId: z.string(),
  dex: z.string(),
  poolAddress: z.string(),
  handler: z.literal("uniswap_v3").optional(),
  tokenIn: z.string(),
  tokenOut: z.string(),
  feeBps: z.number().int().nonnegative(),
});

const poolConfigSchema = z.array(z.union([v2PoolSchema, v2FactorySchema, stablePoolSchema, v3PoolSchema]));

export async function loadPoolConfig(path: string): Promise<PoolConfig[]> {
  const raw = await readFile(path, "utf8");
  return poolConfigSchema.parse(JSON.parse(raw));
}
