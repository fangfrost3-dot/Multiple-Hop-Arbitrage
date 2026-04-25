import { readFile } from "node:fs/promises";
import { z } from "zod";
const v2RouteSchema = z.object({
    kind: z.literal("v2"),
    adapter: z.string(),
    tokenIn: z.string(),
    tokenOut: z.string(),
    router: z.string(),
    path: z.array(z.string()).min(2),
    amountOutMin: z.string(),
    deadlineSeconds: z.number().int().positive(),
});
const v3RouteSchema = z.object({
    kind: z.literal("v3"),
    adapter: z.string(),
    tokenIn: z.string(),
    tokenOut: z.string(),
    router: z.string(),
    fee: z.number().int().nonnegative(),
    amountOutMin: z.string(),
    deadlineSeconds: z.number().int().positive(),
    sqrtPriceLimitX96: z.string(),
});
const executionRouteSchema = z.array(z.object({
    cycleId: z.string(),
    borrowToken: z.string(),
    profitToken: z.string(),
    minProfit: z.string(),
    swaps: z.array(z.union([v2RouteSchema, v3RouteSchema])).min(1),
}));
export async function loadRouteConfig(path) {
    const raw = await readFile(path, "utf8");
    return executionRouteSchema.parse(JSON.parse(raw));
}
