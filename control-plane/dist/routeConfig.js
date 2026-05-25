import { readFile } from "node:fs/promises";
import { isAddress } from "ethers";
import { z } from "zod";
const addressSchema = z.string().trim().refine((value) => isAddress(value), "must be a valid address");
const v2RouteSchema = z.object({
    kind: z.literal("v2"),
    adapter: addressSchema,
    tokenIn: addressSchema,
    tokenOut: addressSchema,
    router: addressSchema,
    path: z.array(addressSchema).min(2),
    amountOutMin: z.string(),
    deadlineSeconds: z.number().int().positive(),
});
const v3RouteSchema = z.object({
    kind: z.literal("v3"),
    adapter: addressSchema,
    tokenIn: addressSchema,
    tokenOut: addressSchema,
    router: addressSchema,
    fee: z.number().int().nonnegative(),
    amountOutMin: z.string(),
    deadlineSeconds: z.number().int().positive(),
    sqrtPriceLimitX96: z.string(),
});
const oneInchRouteSchema = z.object({
    kind: z.literal("one_inch"),
    adapter: addressSchema,
    tokenIn: addressSchema,
    tokenOut: addressSchema,
    router: addressSchema,
    chainId: z.number().int().positive(),
    slippageBps: z.number().int().positive().max(10_000),
    protocols: z.array(z.string()).optional(),
    referrerAddress: addressSchema.optional(),
    complexityLevel: z.number().int().nonnegative().optional(),
    disableEstimate: z.boolean().optional(),
    allowPartialFill: z.boolean().optional(),
    includeTokensInfo: z.boolean().optional(),
    includeProtocols: z.boolean().optional(),
    includeGas: z.boolean().optional(),
});
const executionRouteSchema = z.array(z.object({
    cycleId: z.string(),
    borrowToken: addressSchema,
    profitToken: addressSchema,
    minProfit: z.string(),
    maxBorrowAmount: z.string().optional(),
    swaps: z.array(z.union([v2RouteSchema, v3RouteSchema, oneInchRouteSchema])).min(1),
}).superRefine((route, ctx) => {
    if (route.profitToken.toLowerCase() !== route.borrowToken.toLowerCase()) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["profitToken"],
            message: "must match borrowToken because FlashLoanExecutor realizes profit in the borrowed asset",
        });
    }
    const firstSwap = route.swaps[0];
    if (firstSwap.tokenIn.toLowerCase() !== route.borrowToken.toLowerCase()) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["swaps", 0, "tokenIn"],
            message: "first swap tokenIn must match borrowToken",
        });
    }
    route.swaps.forEach((swap, index) => {
        if (swap.kind === "one_inch" && index !== 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["swaps", index, "kind"],
                message: "one_inch swaps are only supported as the first hop",
            });
        }
        if (index === 0) {
            return;
        }
        const previous = route.swaps[index - 1];
        if (swap.tokenIn.toLowerCase() !== previous.tokenOut.toLowerCase()) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["swaps", index, "tokenIn"],
                message: "swap tokenIn must match the previous swap tokenOut",
            });
        }
    });
    const finalSwap = route.swaps[route.swaps.length - 1];
    if (finalSwap.tokenOut.toLowerCase() !== route.borrowToken.toLowerCase()) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["swaps", route.swaps.length - 1, "tokenOut"],
            message: "final swap tokenOut must return to borrowToken",
        });
    }
}));
export async function loadRouteConfig(path) {
    const raw = await readFile(path, "utf8");
    return executionRouteSchema.parse(JSON.parse(raw));
}
