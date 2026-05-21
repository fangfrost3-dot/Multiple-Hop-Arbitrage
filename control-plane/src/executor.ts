import { appendFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname } from "node:path";
import { AbiCoder, Contract, Interface, JsonRpcProvider, Wallet, type TransactionRequest } from "ethers";
import { createLogger } from "./logger.js";
import type { CuMeter } from "./cuMeter.js";
import { flashLoanExecutorAbi } from "./executorAbi.js";
import type { AppConfig } from "./config.js";
import { OneInchClient } from "./oneInch.js";
import type {
  ExecutionCandidate,
  ExecutionJournalEntry,
  ExecutionOutcomeEntry,
  ExecutionRecord,
  ExecutionRouteConfig,
  ExecutorRuntimeSettings,
  ExecutorMetrics,
  ExecutorStatus,
  SwapRouteConfig,
} from "./types.js";

interface CachedFeeData {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  updatedAt: number;
}

interface PreparedV2Swap {
  kind: "v2";
  adapter: string;
  tokenIn: string;
  tokenOut: string;
  router: string;
  path: string[];
  amountOutMin: bigint;
  deadlineSeconds: number;
}

interface PreparedV3Swap {
  kind: "v3";
  adapter: string;
  tokenIn: string;
  tokenOut: string;
  router: string;
  fee: number;
  amountOutMin: bigint;
  deadlineSeconds: number;
  sqrtPriceLimitX96: bigint;
}

interface PreparedOneInchSwap {
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

type PreparedSwap = PreparedV2Swap | PreparedV3Swap | PreparedOneInchSwap;

interface RouteRuntimePlan {
  cycleId: string;
  borrowToken: string;
  borrowTokenLower: string;
  profitToken: string;
  profitTokenLower: string;
  minProfit: bigint;
  swaps: PreparedSwap[];
  routeHops: number;
}

interface CachedGasEstimate {
  gasEstimate: bigint;
  l1CalldataGas: bigint;
  updatedAt: number;
}

interface GasCostEstimate {
  gasLimit: bigint;
  l2GasCostWei: bigint;
  l1CalldataFeeWei: bigint;
  totalGasCostWei: bigint;
}

class NonceCoordinator {
  private provider: JsonRpcProvider;
  private address: string;
  private readonly cuMeter?: CuMeter;
  private nextNonce: number | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(provider: JsonRpcProvider, address: string, cuMeter?: CuMeter) {
    this.provider = provider;
    this.address = address;
    this.cuMeter = cuMeter;
  }

  async acquire(): Promise<number> {
    await this.pending;
    let release: () => void;
    this.pending = new Promise((res) => (release = res));
    try {
      if (this.nextNonce === null) {
        this.nextNonce = await this.provider.getTransactionCount(this.address, "pending");
        this.cuMeter?.recordMethod("eth_getTransactionCount");
      }
      const nonce = this.nextNonce!;
      this.nextNonce = nonce + 1;
      return nonce;
    } finally {
      release!();
    }
  }

  setProvider(provider: JsonRpcProvider) {
    this.provider = provider;
  }
}

export class ExecutorClient {
  private static readonly FEE_CACHE_TTL_MS = 5_000;
  private static readonly GAS_ESTIMATE_TTL_MS = 30_000;
  private static readonly erc20BalanceAbi = ["function balanceOf(address owner) view returns (uint256)"];
  private readonly log = createLogger("executor");
  private readonly cuMeter?: CuMeter;
  private readonly provider?: JsonRpcProvider;
  private readonly relayProvider?: JsonRpcProvider;
  private readonly signerWallet?: Wallet;
  private readonly address?: string;
  private nonceCoordinator?: NonceCoordinator;
  private readonly submissionMode: "public_only" | "relay_preferred" | "relay_only";
  private readonly allowPublicMempool: boolean;
  private readonly contractAddress?: string;
  private readonly profitRecipient?: string;
  private readonly journalPath: string;
  private readonly outcomePath: string;
  private readonly allowedBorrowTokens?: Set<string>;
  private readonly allowedProfitTokens?: Set<string>;
  private readonly allowedAdapters?: Set<string>;
  private readonly allowedRouters?: Set<string>;
  private readonly allowedRouteKinds?: Set<SwapRouteConfig["kind"]>;
  private maxBorrowAmount: bigint;
  private maxRouteHops: number;
  private minProfitRealizationBps: bigint;
  private readonly maxConsecutiveFailures: number;
  private readonly maxTotalFailures: number;
  private maxCumulativeEstimatedLossWei: bigint;
  private readonly wrappedNativeToken?: string;
  private readonly arbitrumNodeInterfaceAddress?: string;
  private readonly arbitrumL1FeePaddingBps: bigint;
  private maxGasCostWei: bigint;
  private readonly confirmations: number;
  private readonly replacementBumpBps: bigint;
  private readonly stuckTxTimeoutMs: number;
  private readonly maxReplacements: number;
  private maxInflight: number;
  private readonly routeByCycleId: Map<string, RouteRuntimePlan>;
  private readonly oneInch: OneInchClient;
  private readonly contractInterface = new Interface(flashLoanExecutorAbi);
  private readonly abiCoder = AbiCoder.defaultAbiCoder();
  private readonly inflight = new Map<string, ExecutionRecord>();
  private readonly gasEstimateCache = new Map<string, CachedGasEstimate>();
  private readonly metrics: ExecutorMetrics = {
    submitted: 0,
    submittedPublic: 0,
    submittedRelay: 0,
    confirmed: 0,
    reverted: 0,
    dropped: 0,
    replaced: 0,
    riskRejected: 0,
    consecutiveFailures: 0,
    totalFailures: 0,
    inflight: 0,
  };
  private cumulativeEstimatedNetWei = 0n;
  private paused: boolean;
  private pauseReason?: string;
  private feeDataCache?: CachedFeeData;
  private feeRefreshPromise?: Promise<void>;

  constructor(config: AppConfig, routes: ExecutionRouteConfig[], cuMeter?: CuMeter) {
    this.cuMeter = cuMeter;
    this.oneInch = new OneInchClient(config.ONE_INCH_API_KEY, config.ONE_INCH_API_BASE_URL);
    if (routes.some((route) => route.swaps.some((swap) => swap.kind === "one_inch")) && !this.oneInch.isEnabled()) {
      throw new Error("ONE_INCH_API_KEY is required when one_inch routes are configured");
    }
    this.routeByCycleId = new Map(
      routes.map((route) => [
        route.cycleId,
        {
          cycleId: route.cycleId,
          borrowToken: route.borrowToken,
          borrowTokenLower: route.borrowToken.toLowerCase(),
          profitToken: route.profitToken,
          profitTokenLower: route.profitToken.toLowerCase(),
          minProfit: BigInt(route.minProfit),
          swaps: route.swaps.map((swap) => {
            if (swap.kind === "v2") {
              return {
                kind: "v2" as const,
                adapter: swap.adapter,
                tokenIn: swap.tokenIn,
                tokenOut: swap.tokenOut,
                router: swap.router,
                path: swap.path,
                amountOutMin: BigInt(swap.amountOutMin),
                deadlineSeconds: swap.deadlineSeconds,
              };
            }
            if (swap.kind === "v3") {
              return {
                kind: "v3" as const,
                adapter: swap.adapter,
                tokenIn: swap.tokenIn,
                tokenOut: swap.tokenOut,
                router: swap.router,
                fee: swap.fee,
                amountOutMin: BigInt(swap.amountOutMin),
                deadlineSeconds: swap.deadlineSeconds,
                sqrtPriceLimitX96: BigInt(swap.sqrtPriceLimitX96),
              };
            }

            return {
              kind: "one_inch" as const,
              adapter: swap.adapter,
              tokenIn: swap.tokenIn,
              tokenOut: swap.tokenOut,
              router: swap.router,
              chainId: swap.chainId,
              slippageBps: swap.slippageBps,
              protocols: swap.protocols,
              referrerAddress: swap.referrerAddress,
              complexityLevel: swap.complexityLevel,
              disableEstimate: swap.disableEstimate,
              allowPartialFill: swap.allowPartialFill,
              includeTokensInfo: swap.includeTokensInfo,
              includeProtocols: swap.includeProtocols,
              includeGas: swap.includeGas,
            };
          }),
          routeHops: route.swaps.length,
        },
      ]),
    );
    this.contractAddress = config.EXECUTOR_CONTRACT_ADDRESS;
    this.profitRecipient = config.EXECUTOR_PROFIT_RECIPIENT;
    this.submissionMode = config.EXECUTOR_SUBMISSION_MODE;
    this.allowPublicMempool = config.EXECUTOR_ALLOW_PUBLIC_MEMPOOL;
    this.journalPath = config.EXECUTOR_JOURNAL_PATH;
    this.outcomePath = config.EXECUTOR_OUTCOME_PATH;
    this.allowedBorrowTokens = this.parseAddressSet(config.EXECUTOR_ALLOWED_BORROW_TOKENS);
    this.allowedProfitTokens = this.parseAddressSet(config.EXECUTOR_ALLOWED_PROFIT_TOKENS);
    this.allowedAdapters = this.parseAddressSet(config.EXECUTOR_ALLOWED_ADAPTERS);
    this.allowedRouters = this.parseAddressSet(config.EXECUTOR_ALLOWED_ROUTERS);
    this.allowedRouteKinds = this.parseRouteKindSet(config.EXECUTOR_ALLOWED_ROUTE_KINDS);
    this.maxBorrowAmount = config.EXECUTOR_MAX_BORROW_AMOUNT;
    this.maxRouteHops = config.EXECUTOR_MAX_ROUTE_HOPS;
    this.minProfitRealizationBps = BigInt(config.EXECUTOR_MIN_PROFIT_REALIZATION_BPS);
    this.maxConsecutiveFailures = config.EXECUTOR_MAX_CONSECUTIVE_FAILURES;
    this.maxTotalFailures = config.EXECUTOR_MAX_TOTAL_FAILURES;
    this.maxCumulativeEstimatedLossWei = config.EXECUTOR_MAX_CUMULATIVE_ESTIMATED_LOSS_WEI;
    this.wrappedNativeToken = config.WRAPPED_NATIVE_TOKEN?.toLowerCase();
    this.arbitrumNodeInterfaceAddress = config.ARBITRUM_NODE_INTERFACE_ADDRESS;
    this.arbitrumL1FeePaddingBps = BigInt(config.ARBITRUM_L1_FEE_PADDING_BPS);
    this.maxGasCostWei = config.MAX_GAS_COST_WEI;
    this.confirmations = config.EXECUTOR_CONFIRMATIONS;
    this.replacementBumpBps = BigInt(config.EXECUTOR_REPLACEMENT_BUMP_BPS);
    this.stuckTxTimeoutMs = config.EXECUTOR_STUCK_TX_TIMEOUT_MS;
    this.maxReplacements = config.EXECUTOR_MAX_REPLACEMENTS;
    this.maxInflight = config.EXECUTOR_MAX_INFLIGHT;
    this.paused = config.EXECUTOR_START_PAUSED;
    this.pauseReason = config.EXECUTOR_START_PAUSED ? "executor start paused by configuration" : undefined;

    if (config.RPC_URL) {
      this.provider = new JsonRpcProvider(config.RPC_URL);
    }

    if (config.EXECUTOR_PRIVATE_KEY) {
      this.signerWallet = new Wallet(config.EXECUTOR_PRIVATE_KEY);
      this.address = this.signerWallet.address.toLowerCase();
    }

    if (config.PRIVATE_RELAY_RPC_URL) {
      this.relayProvider = new JsonRpcProvider(config.PRIVATE_RELAY_RPC_URL);
    }

    if (this.signerWallet && (this.provider || this.relayProvider)) {
      const probe = this.provider ?? this.relayProvider!;
      this.nonceCoordinator = new NonceCoordinator(probe, this.signerWallet.address, this.cuMeter);
    }

    if (this.provider) {
      if (!this.paused) {
        void this.refreshFeeData();
      }
      setInterval(() => {
        if (!this.paused) {
          void this.refreshFeeData();
        }
      }, ExecutorClient.FEE_CACHE_TTL_MS).unref();
    }
  }

  async handleCandidate(candidate: ExecutionCandidate): Promise<void> {
    const startedAt = performance.now();
    const mark = () => Math.round((performance.now() - startedAt) * 100) / 100;

    if (this.paused) {
      this.metrics.riskRejected += 1;
      this.log.info({ cycleId: candidate.cycle_id, pauseReason: this.pauseReason }, "candidate rejected because executor is paused");
      await this.writeJournal({
        timestamp: Date.now(),
        event: "risk_rejected",
        cycleId: candidate.cycle_id,
        reason: this.pauseReason ?? "executor paused",
        borrowToken: candidate.borrow_token,
        borrowAmount: candidate.borrow_amount,
        expectedProfit: candidate.expected_profit,
      });
      return;
    }
    const submissionDisabledReason = this.submissionDisabledReason();
    if (submissionDisabledReason) {
      this.metrics.riskRejected += 1;
      this.log.info({ cycleId: candidate.cycle_id, reason: submissionDisabledReason }, "candidate rejected because submission is not ready");
      await this.writeJournal({
        timestamp: Date.now(),
        event: "risk_rejected",
        cycleId: candidate.cycle_id,
        reason: submissionDisabledReason,
        borrowToken: candidate.borrow_token,
        borrowAmount: candidate.borrow_amount,
        expectedProfit: candidate.expected_profit,
      });
      return;
    }
    const routePlan = this.routeByCycleId.get(candidate.cycle_id);
    if (!routePlan) {
      this.log.debug({ cycleId: candidate.cycle_id }, "skipping candidate without route config");
      return;
    }
    const { routeHops } = routePlan;
    const riskReason = this.rejectReason(candidate, routePlan);
    if (riskReason) {
      this.metrics.riskRejected += 1;
      this.log.info({ cycleId: candidate.cycle_id, reason: riskReason }, "candidate rejected by risk control");
      await this.writeJournal({
        timestamp: Date.now(),
        event: "risk_rejected",
        cycleId: candidate.cycle_id,
        reason: riskReason,
        borrowToken: candidate.borrow_token,
        borrowAmount: candidate.borrow_amount,
        expectedProfit: candidate.expected_profit,
        routeHops,
      });
      return;
    }
    const validationMs = mark();

    if (!this.contractAddress || !this.profitRecipient || !this.provider) {
      this.log.info({ cycleId: candidate.cycle_id }, "executor not fully configured; candidate not submitted");
      return;
    }
    if (this.inflight.size >= this.maxInflight) {
      this.log.info({ cycleId: candidate.cycle_id, inflight: this.inflight.size }, "skipping candidate because max inflight transactions reached");
      return;
    }
    if (routePlan.borrowTokenLower !== candidate.borrow_token.toLowerCase()) {
      this.log.error({ cycleId: candidate.cycle_id }, "route borrow token does not match candidate");
      return;
    }

    const effectiveMinProfit = this.effectiveMinProfit(routePlan, BigInt(candidate.expected_profit));
    if (BigInt(candidate.expected_profit) <= effectiveMinProfit) {
      const reason = "candidate expected profit below slippage-adjusted minimum profit gate";
      this.metrics.riskRejected += 1;
      this.log.info(
        {
          cycleId: candidate.cycle_id,
          expectedProfit: candidate.expected_profit,
          effectiveMinProfit: effectiveMinProfit.toString(),
        },
        reason,
      );
      await this.writeJournal({
        timestamp: Date.now(),
        event: "risk_rejected",
        cycleId: candidate.cycle_id,
        reason,
        borrowToken: candidate.borrow_token,
        borrowAmount: candidate.borrow_amount,
        expectedProfit: candidate.expected_profit,
        routeHops,
        details: {
          configuredMinProfit: routePlan.minProfit.toString(),
          minProfitRealizationBps: Number(this.minProfitRealizationBps),
          effectiveMinProfit: effectiveMinProfit.toString(),
        },
      });
      return;
    }

    const params = await this.encodeExecutionPlan(routePlan, BigInt(candidate.borrow_amount), effectiveMinProfit);
    const calldata = this.contractInterface.encodeFunctionData("requestFlashLoan", [
      candidate.borrow_token,
      BigInt(candidate.borrow_amount),
      params,
    ]);

    const estimationAddress = this.address;
    if (!estimationAddress || !this.provider) {
      this.log.info({ cycleId: candidate.cycle_id }, "no signer configured for execution submission");
      return;
    }

    const feeData = await this.getCachedFeeData();
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!gasPrice) {
      this.log.error({ cycleId: candidate.cycle_id }, "missing gas price data");
      return;
    }
    const gasCost = await this.getGasCostEstimate(candidate.cycle_id, estimationAddress, calldata, gasPrice);
    const rpcPrepMs = mark();

    const estimatedGasCostWei = gasCost.totalGasCostWei;
    if (this.maxGasCostWei > 0n && estimatedGasCostWei > this.maxGasCostWei) {
      const reason = "candidate rejected above max gas cost gate";
      this.metrics.riskRejected += 1;
      this.log.info(
        {
          cycleId: candidate.cycle_id,
          estimatedGasCostWei: estimatedGasCostWei.toString(),
          estimatedL2GasCostWei: gasCost.l2GasCostWei.toString(),
          estimatedL1CalldataFeeWei: gasCost.l1CalldataFeeWei.toString(),
          maxGasCostWei: this.maxGasCostWei.toString(),
        },
        reason,
      );
      await this.writeJournal({
        timestamp: Date.now(),
        event: "risk_rejected",
        cycleId: candidate.cycle_id,
        reason,
        borrowToken: candidate.borrow_token,
        borrowAmount: candidate.borrow_amount,
        expectedProfit: candidate.expected_profit,
        routeHops,
        details: {
          estimatedGasCostWei: estimatedGasCostWei.toString(),
          estimatedL2GasCostWei: gasCost.l2GasCostWei.toString(),
          estimatedL1CalldataFeeWei: gasCost.l1CalldataFeeWei.toString(),
          maxGasCostWei: this.maxGasCostWei.toString(),
        },
      });
      return;
    }

    if (this.wrappedNativeToken && candidate.borrow_token.toLowerCase() === this.wrappedNativeToken) {
      const requiredProfit = estimatedGasCostWei + effectiveMinProfit;
      if (BigInt(candidate.expected_profit) <= requiredProfit) {
        const reason = "candidate rejected below gas-adjusted profit gate";
        this.metrics.riskRejected += 1;
        this.log.info(
          {
            cycleId: candidate.cycle_id,
            expectedProfit: candidate.expected_profit,
            estimatedGasCostWei: estimatedGasCostWei.toString(),
            estimatedL2GasCostWei: gasCost.l2GasCostWei.toString(),
            estimatedL1CalldataFeeWei: gasCost.l1CalldataFeeWei.toString(),
            requiredProfit: requiredProfit.toString(),
          },
          reason,
        );
        await this.writeJournal({
          timestamp: Date.now(),
          event: "risk_rejected",
          cycleId: candidate.cycle_id,
          reason,
          borrowToken: candidate.borrow_token,
          borrowAmount: candidate.borrow_amount,
          expectedProfit: candidate.expected_profit,
          routeHops,
          details: {
            estimatedGasCostWei: estimatedGasCostWei.toString(),
            estimatedL2GasCostWei: gasCost.l2GasCostWei.toString(),
            estimatedL1CalldataFeeWei: gasCost.l1CalldataFeeWei.toString(),
            effectiveMinProfit: effectiveMinProfit.toString(),
            requiredProfit: requiredProfit.toString(),
          },
        });
        return;
      }
    }

    const txRequest: TransactionRequest = {
      to: this.contractAddress,
      data: calldata,
      gasLimit: (gasCost.gasLimit * 12n) / 10n,
      maxFeePerGas: feeData.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
      gasPrice: feeData.maxFeePerGas ? undefined : gasPrice,
    };

    const profitRecipientBalanceBefore = await this.readProfitRecipientBalance(routePlan.profitToken);
    const { tx, submissionTarget } = await this.sendTransaction(txRequest, candidate.cycle_id);
    const submissionMs = mark();
    const submittedAt = Date.now();
    const execution: ExecutionRecord = {
      cycleId: candidate.cycle_id,
      txHash: tx.hash,
      nonce: tx.nonce,
      submittedAt,
      lastBroadcastAt: submittedAt,
      replacementCount: 0,
      submissionTarget,
      borrowToken: candidate.borrow_token,
      borrowAmount: candidate.borrow_amount,
      expectedProfit: candidate.expected_profit,
      profitToken: routePlan.profitToken,
      profitRecipient: this.profitRecipient,
      profitRecipientBalanceBefore: profitRecipientBalanceBefore?.toString(),
      routeHops,
      gasLimit: String(txRequest.gasLimit ?? 0n),
      estimatedGasCostWei: estimatedGasCostWei.toString(),
      estimatedL2GasCostWei: gasCost.l2GasCostWei.toString(),
      estimatedL1CalldataFeeWei: gasCost.l1CalldataFeeWei.toString(),
      maxFeePerGas: txRequest.maxFeePerGas ? String(txRequest.maxFeePerGas) : undefined,
      maxPriorityFeePerGas: txRequest.maxPriorityFeePerGas ? String(txRequest.maxPriorityFeePerGas) : undefined,
      gasPrice: txRequest.gasPrice ? String(txRequest.gasPrice) : undefined,
    };
    this.inflight.set(tx.hash, execution);
    this.metrics.submitted += 1;
    if (submissionTarget === "relay") {
      this.metrics.submittedRelay += 1;
    } else {
      this.metrics.submittedPublic += 1;
    }
    this.metrics.inflight = this.inflight.size;

    this.log.info(
      {
        cycleId: candidate.cycle_id,
        hash: tx.hash,
      submissionTarget,
      timingsMs: {
          validation: validationMs,
          rpcPrep: Math.round((rpcPrepMs - validationMs) * 100) / 100,
          submission: Math.round((submissionMs - rpcPrepMs) * 100) / 100,
          total: submissionMs,
        },
      },
      "submitted execution transaction",
    );
    await this.writeJournal({
      timestamp: execution.submittedAt,
      event: "submitted",
      cycleId: execution.cycleId,
      txHash: execution.txHash,
      nonce: execution.nonce,
      borrowToken: execution.borrowToken,
      borrowAmount: execution.borrowAmount,
      expectedProfit: execution.expectedProfit,
      routeHops: execution.routeHops,
      details: {
        submissionTarget: execution.submissionTarget,
        gasLimit: execution.gasLimit,
        estimatedGasCostWei: execution.estimatedGasCostWei,
        estimatedL2GasCostWei: execution.estimatedL2GasCostWei,
        estimatedL1CalldataFeeWei: execution.estimatedL1CalldataFeeWei,
        maxFeePerGas: execution.maxFeePerGas,
        maxPriorityFeePerGas: execution.maxPriorityFeePerGas,
        gasPrice: execution.gasPrice,
        replacementCount: execution.replacementCount,
        validationMs,
        rpcPrepMs: Math.round((rpcPrepMs - validationMs) * 100) / 100,
        submissionMs: Math.round((submissionMs - rpcPrepMs) * 100) / 100,
        totalMs: submissionMs,
      },
    });
    void this.trackTransaction(tx.hash).catch((error: unknown) => {
      this.log.error({ hash: tx.hash, error }, "transaction tracking failed");
    });
  }

  hasRoute(cycleId: string): boolean {
    return this.routeByCycleId.has(cycleId);
  }

  private async encodeExecutionPlan(route: RouteRuntimePlan, borrowAmount: bigint, minProfit: bigint): Promise<string> {
    const swaps = await Promise.all(route.swaps.map(async (swap, index) => [
      swap.adapter,
      swap.tokenIn,
      swap.tokenOut,
      await this.encodeRouteData(swap, index === 0 ? borrowAmount : undefined),
    ]));

    return this.abiCoder.encode(
      [
        "tuple(address profitToken,uint256 minProfit,address profitRecipient,tuple(address adapter,address tokenIn,address tokenOut,bytes routeData)[] swaps)",
      ],
      [[route.profitToken, minProfit, this.profitRecipient, swaps]],
    );
  }

  private effectiveMinProfit(route: RouteRuntimePlan, expectedProfit: bigint): bigint {
    if (this.minProfitRealizationBps <= 0n) {
      return route.minProfit;
    }

    const realizedProfitFloor = (expectedProfit * this.minProfitRealizationBps) / 10_000n;
    return realizedProfitFloor > route.minProfit ? realizedProfitFloor : route.minProfit;
  }

  private async encodeRouteData(swap: PreparedSwap, amountIn?: bigint): Promise<string> {
    if (swap.kind === "v2") {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + swap.deadlineSeconds);
      return this.abiCoder.encode(
        ["tuple(address router,address[] path,uint256 amountOutMin,uint256 deadline)"],
        [[swap.router, swap.path, swap.amountOutMin, deadline]],
      );
    }

    if (swap.kind === "v3") {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + swap.deadlineSeconds);
      return this.abiCoder.encode(
        ["tuple(address router,uint24 fee,uint256 amountOutMin,uint256 deadline,uint160 sqrtPriceLimitX96)"],
        [[swap.router, swap.fee, swap.amountOutMin, deadline, swap.sqrtPriceLimitX96]],
      );
    }

    if (!this.contractAddress) {
      throw new Error("executor contract address missing for one_inch route encoding");
    }
    if (amountIn === undefined) {
      throw new Error("one_inch routes are only supported as the first hop of an execution plan");
    }

    const quote = await this.oneInch.buildSwap({
      chainId: swap.chainId,
      fromTokenAddress: swap.tokenIn,
      toTokenAddress: swap.tokenOut,
      amount: amountIn,
      fromAddress: swap.adapter,
      receiver: this.contractAddress,
      slippageBps: swap.slippageBps,
      protocols: swap.protocols,
      referrerAddress: swap.referrerAddress,
      complexityLevel: swap.complexityLevel,
      disableEstimate: swap.disableEstimate,
      allowPartialFill: swap.allowPartialFill,
      includeTokensInfo: swap.includeTokensInfo,
      includeProtocols: swap.includeProtocols,
      includeGas: swap.includeGas,
    });

    if (quote.tx.to.toLowerCase() !== swap.router.toLowerCase()) {
      throw new Error(`1inch router mismatch for adapter ${swap.adapter}`);
    }
    if (quote.tx.value && quote.tx.value !== "0") {
      throw new Error("1inch route returned non-zero native value; ERC20-only adapter rejects this");
    }

    return this.abiCoder.encode(["tuple(address router,bytes data)"], [[swap.router, quote.tx.data]]);
  }

  private async getGasCostEstimate(cycleId: string, from: string, calldata: string, gasPriceWei: bigint): Promise<GasCostEstimate> {
    const now = Date.now();
    const cacheKey = `${cycleId}:${calldata}`;
    const cached = this.gasEstimateCache.get(cacheKey);
    if (cached && now - cached.updatedAt <= ExecutorClient.GAS_ESTIMATE_TTL_MS) {
      return this.toGasCostEstimate(cached.gasEstimate, cached.l1CalldataGas, gasPriceWei);
    }

    if (!this.provider || !this.contractAddress) {
      throw new Error("provider or contract address missing for gas estimation");
    }

    const tx = {
      to: this.contractAddress,
      from,
      data: calldata,
    };
    const gasEstimate = await this.provider.estimateGas(tx);
    this.cuMeter?.recordMethod("eth_estimateGas");
    const l1CalldataGas = await this.estimateArbitrumL1CalldataGas(tx);
    this.gasEstimateCache.set(cacheKey, { gasEstimate, l1CalldataGas, updatedAt: now });
    return this.toGasCostEstimate(gasEstimate, l1CalldataGas, gasPriceWei);
  }

  private toGasCostEstimate(gasEstimate: bigint, l1CalldataGas: bigint, gasPriceWei: bigint): GasCostEstimate {
    const boundedL1CalldataGas = l1CalldataGas > gasEstimate ? gasEstimate : l1CalldataGas;
    const l2Gas = gasEstimate - boundedL1CalldataGas;
    const paddedL1CalldataGas =
      this.arbitrumL1FeePaddingBps > 0n
        ? (boundedL1CalldataGas * (10_000n + this.arbitrumL1FeePaddingBps)) / 10_000n
        : boundedL1CalldataGas;
    const l2GasCostWei = l2Gas * gasPriceWei;
    const l1CalldataFeeWei = paddedL1CalldataGas * gasPriceWei;
    return {
      gasLimit: l2Gas + paddedL1CalldataGas,
      l2GasCostWei,
      l1CalldataFeeWei,
      totalGasCostWei: l2GasCostWei + l1CalldataFeeWei,
    };
  }

  private async estimateArbitrumL1CalldataGas(tx: { to: string; from: string; data: string }): Promise<bigint> {
    if (!this.provider || !this.arbitrumNodeInterfaceAddress) {
      return 0n;
    }

    const iface = new Interface([
      "function gasEstimateComponents(address to,bool contractCreation,bytes data) view returns (uint64 gasEstimate,uint64 gasEstimateForL1,uint256 baseFee,uint256 l1BaseFeeEstimate)",
    ]);

    try {
      const response = await this.provider.call({
        to: this.arbitrumNodeInterfaceAddress,
        from: tx.from,
        data: iface.encodeFunctionData("gasEstimateComponents", [tx.to, false, tx.data]),
      });
      this.cuMeter?.recordMethod("arb_gasEstimateComponents");
      const decoded = iface.decodeFunctionResult("gasEstimateComponents", response);
      return BigInt(String(decoded.gasEstimateForL1));
    } catch (error) {
      this.log.error({ error }, "arbitrum l1 calldata fee estimate failed; falling back to l2 gas estimate only");
      return 0n;
    }
  }

  private async getCachedFeeData(): Promise<CachedFeeData> {
    const now = Date.now();
    if (this.feeDataCache && now - this.feeDataCache.updatedAt <= ExecutorClient.FEE_CACHE_TTL_MS) {
      return this.feeDataCache;
    }

    await this.refreshFeeData();
    if (!this.feeDataCache) {
      throw new Error("fee data unavailable");
    }

    return this.feeDataCache;
  }

  private async refreshFeeData(): Promise<void> {
    if (!this.provider) {
      return;
    }
    if (this.feeRefreshPromise) {
      return this.feeRefreshPromise;
    }

    this.feeRefreshPromise = this.provider
      .getFeeData()
      .then((feeData) => {
        this.cuMeter?.recordMethod("eth_getBlockByNumber");
        this.cuMeter?.recordMethod("eth_gasPrice");
        this.cuMeter?.recordMethod("eth_maxPriorityFeePerGas");
        this.feeDataCache = {
          maxFeePerGas: feeData.maxFeePerGas ?? undefined,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
          gasPrice: feeData.gasPrice ?? undefined,
          updatedAt: Date.now(),
        };
      })
      .catch((error: unknown) => {
        this.log.error({ error }, "fee data refresh failed");
      })
      .finally(() => {
        this.feeRefreshPromise = undefined;
      });

    await this.feeRefreshPromise;
  }

  private async trackTransaction(hash: string): Promise<void> {
    if (!this.provider) {
      return;
    }
    const record = this.inflight.get(hash);
    if (!record) {
      return;
    }

    const receipt = await this.provider.waitForTransaction(hash, this.confirmations);
    this.cuMeter?.recordMethod("eth_getTransactionReceipt");
    this.inflight.delete(hash);
    this.metrics.inflight = this.inflight.size;
    if (!receipt) {
      this.recordFailure("dropped");
      this.log.error({ hash }, "transaction dropped without receipt");
      await this.writeJournal({
        timestamp: Date.now(),
        event: "dropped",
        cycleId: record.cycleId,
        txHash: hash,
        nonce: record.nonce,
        borrowToken: record.borrowToken,
        borrowAmount: record.borrowAmount,
        expectedProfit: record.expectedProfit,
        routeHops: record.routeHops,
      });
      await this.writeOutcome({
        timestamp: Date.now(),
        cycleId: record.cycleId,
        txHash: hash,
        nonce: record.nonce,
        status: "dropped",
        submissionTarget: record.submissionTarget,
        borrowToken: record.borrowToken,
        borrowAmount: record.borrowAmount,
        expectedProfit: record.expectedProfit,
        routeHops: record.routeHops,
        cumulativeEstimatedNetWei: this.cumulativeEstimatedNetWei.toString(),
      });
      await this.maybePause("transaction dropped without receipt");
      return;
    }

    if (receipt.status === 1) {
      this.metrics.confirmed += 1;
      this.metrics.consecutiveFailures = 0;
      const txCostWei = this.transactionCostWei(receipt);
      const estimatedNetProfitWei = this.estimatedNetProfitWei(record, txCostWei);
      this.applyEstimatedNet(estimatedNetProfitWei);
      this.log.info({ hash, cycleId: record.cycleId, blockNumber: receipt.blockNumber }, "execution transaction confirmed");
      await this.writeJournal({
        timestamp: Date.now(),
        event: "confirmed",
        cycleId: record.cycleId,
        txHash: hash,
        nonce: record.nonce,
        borrowToken: record.borrowToken,
        borrowAmount: record.borrowAmount,
        expectedProfit: record.expectedProfit,
        routeHops: record.routeHops,
        details: {
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
        },
      });
      await this.writeOutcome({
        timestamp: Date.now(),
        cycleId: record.cycleId,
        txHash: hash,
        nonce: record.nonce,
        status: "confirmed",
        submissionTarget: record.submissionTarget,
        borrowToken: record.borrowToken,
        borrowAmount: record.borrowAmount,
        expectedProfit: record.expectedProfit,
        routeHops: record.routeHops,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        txCostWei: txCostWei.toString(),
        estimatedNetProfitWei: estimatedNetProfitWei?.toString(),
        realizedProfitTokenDelta: (await this.realizedProfitTokenDelta(record))?.toString(),
        cumulativeEstimatedNetWei: this.cumulativeEstimatedNetWei.toString(),
      });
      await this.maybePauseOnEstimatedLoss("confirmed transaction estimated net below threshold");
      return;
    }

    this.recordFailure("reverted");
    const txCostWei = this.transactionCostWei(receipt);
    const estimatedNetProfitWei = this.estimatedNetProfitWei(record, txCostWei) ?? (-txCostWei);
    this.applyEstimatedNet(estimatedNetProfitWei);
    this.log.error({ hash, cycleId: record.cycleId, blockNumber: receipt.blockNumber }, "execution transaction reverted");
    await this.writeJournal({
      timestamp: Date.now(),
      event: "reverted",
      cycleId: record.cycleId,
      txHash: hash,
      nonce: record.nonce,
      borrowToken: record.borrowToken,
      borrowAmount: record.borrowAmount,
      expectedProfit: record.expectedProfit,
      routeHops: record.routeHops,
      details: {
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
      },
    });
    await this.writeOutcome({
      timestamp: Date.now(),
      cycleId: record.cycleId,
      txHash: hash,
      nonce: record.nonce,
      status: "reverted",
      submissionTarget: record.submissionTarget,
      borrowToken: record.borrowToken,
      borrowAmount: record.borrowAmount,
      expectedProfit: record.expectedProfit,
      routeHops: record.routeHops,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      txCostWei: txCostWei.toString(),
      estimatedNetProfitWei: estimatedNetProfitWei.toString(),
      realizedProfitTokenDelta: (await this.realizedProfitTokenDelta(record))?.toString(),
      cumulativeEstimatedNetWei: this.cumulativeEstimatedNetWei.toString(),
    });
    await this.maybePause("transaction reverted");
    await this.maybePauseOnEstimatedLoss("reverted transaction estimated loss threshold reached");
  }

  async rebroadcastInflight(): Promise<void> {
    if (!this.provider) {
      return;
    }

    for (const record of this.inflight.values()) {
      if (Date.now() - record.lastBroadcastAt < this.stuckTxTimeoutMs) {
        continue;
      }
      if (record.replacementCount >= this.maxReplacements) {
        this.log.error({ hash: record.txHash, cycleId: record.cycleId, replacementCount: record.replacementCount }, "max transaction replacements reached");
        await this.pause(`circuit breaker triggered: tx replacement limit reached for ${record.cycleId}`);
        continue;
      }

      const tx = await this.provider.getTransaction(record.txHash);
      this.cuMeter?.recordMethod("eth_getTransactionByHash");
      if (!tx || tx.blockNumber) {
        continue;
      }

      const bumped = {
        to: tx.to,
        data: tx.data,
        nonce: tx.nonce,
        gasLimit: tx.gasLimit,
        maxFeePerGas: tx.maxFeePerGas
          ? (tx.maxFeePerGas * (10_000n + this.replacementBumpBps)) / 10_000n
          : undefined,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas
          ? (tx.maxPriorityFeePerGas * (10_000n + this.replacementBumpBps)) / 10_000n
          : undefined,
        gasPrice: tx.gasPrice
          ? (tx.gasPrice * (10_000n + this.replacementBumpBps)) / 10_000n
          : undefined,
      } satisfies TransactionRequest;

      const signer = this.signerForTarget(record.submissionTarget);
      if (!signer) {
        this.log.error({ hash: record.txHash, submissionTarget: record.submissionTarget }, "missing signer for replacement");
        continue;
      }

      const replacement = await signer.sendTransaction(bumped);
      this.inflight.delete(record.txHash);
      this.inflight.set(replacement.hash, {
        ...record,
        txHash: replacement.hash,
        lastBroadcastAt: Date.now(),
        replacementCount: record.replacementCount + 1,
        maxFeePerGas: bumped.maxFeePerGas ? String(bumped.maxFeePerGas) : record.maxFeePerGas,
        maxPriorityFeePerGas: bumped.maxPriorityFeePerGas ? String(bumped.maxPriorityFeePerGas) : record.maxPriorityFeePerGas,
        gasPrice: bumped.gasPrice ? String(bumped.gasPrice) : record.gasPrice,
      });
      this.metrics.replaced += 1;
      this.metrics.inflight = this.inflight.size;
      this.log.info({ replaced: record.txHash, replacement: replacement.hash, nonce: replacement.nonce }, "rebroadcast inflight transaction with fee bump");
      await this.writeJournal({
        timestamp: Date.now(),
        event: "replaced",
        cycleId: record.cycleId,
        txHash: replacement.hash,
        nonce: replacement.nonce,
        borrowToken: record.borrowToken,
        borrowAmount: record.borrowAmount,
        expectedProfit: record.expectedProfit,
        routeHops: record.routeHops,
        details: {
          replacedHash: record.txHash,
          submissionTarget: record.submissionTarget,
          replacementCount: record.replacementCount + 1,
          maxFeePerGas: bumped.maxFeePerGas?.toString(),
          maxPriorityFeePerGas: bumped.maxPriorityFeePerGas?.toString(),
          gasPrice: bumped.gasPrice?.toString(),
        },
      });
      void this.trackTransaction(replacement.hash);
    }
  }

  status(): ExecutorStatus {
    return {
      paused: this.paused,
      pauseReason: this.pauseReason,
      metrics: {
        ...this.metrics,
        inflight: this.inflight.size,
      },
      cumulativeEstimatedNetWei: this.cumulativeEstimatedNetWei.toString(),
      settings: this.settings(),
    };
  }

  settings(): ExecutorRuntimeSettings {
    return {
      maxBorrowAmount: this.maxBorrowAmount.toString(),
      maxRouteHops: this.maxRouteHops,
      minProfitRealizationBps: Number(this.minProfitRealizationBps),
      maxGasCostWei: this.maxGasCostWei.toString(),
      maxCumulativeEstimatedLossWei: this.maxCumulativeEstimatedLossWei.toString(),
      maxInflight: this.maxInflight,
    };
  }

  updateSettings(settings: Partial<ExecutorRuntimeSettings>): ExecutorRuntimeSettings {
    if (settings.maxBorrowAmount !== undefined) {
      this.maxBorrowAmount = BigInt(settings.maxBorrowAmount);
    }
    if (settings.maxRouteHops !== undefined) {
      this.maxRouteHops = settings.maxRouteHops;
    }
    if (settings.minProfitRealizationBps !== undefined) {
      this.minProfitRealizationBps = BigInt(settings.minProfitRealizationBps);
    }
    if (settings.maxGasCostWei !== undefined) {
      this.maxGasCostWei = BigInt(settings.maxGasCostWei);
    }
    if (settings.maxCumulativeEstimatedLossWei !== undefined) {
      this.maxCumulativeEstimatedLossWei = BigInt(settings.maxCumulativeEstimatedLossWei);
    }
    if (settings.maxInflight !== undefined) {
      this.maxInflight = settings.maxInflight;
    }

    this.log.info({ settings: this.settings() }, "executor runtime settings updated");
    return this.settings();
  }

  async resume(): Promise<void> {
    const submissionDisabledReason = this.submissionDisabledReason();
    if (submissionDisabledReason) {
      throw new Error(`cannot resume executor: ${submissionDisabledReason}`);
    }

    this.paused = false;
    this.pauseReason = undefined;
    this.metrics.consecutiveFailures = 0;
    void this.refreshFeeData();
    this.log.info({}, "executor resumed");
    await this.writeJournal({
      timestamp: Date.now(),
      event: "resumed",
      cycleId: "system",
      reason: "manual resume",
    });
  }

  async pauseManual(reason = "manual pause"): Promise<void> {
    await this.pause(reason);
  }

  private async sendTransaction(
    txRequest: TransactionRequest,
    cycleId: string,
  ): Promise<{ tx: any; submissionTarget: "public" | "relay" }> {
    const relayAllowed = this.submissionMode !== "public_only";
    const publicAllowed = this.submissionMode !== "relay_only";
    const nonce = await this.nonceCoordinator?.acquire();

    if (nonce !== undefined) {
      txRequest.nonce = nonce;
    }

    if (!this.signerWallet) {
      throw new Error("no available submission path for executor");
    }

    if (relayAllowed && this.relayProvider) {
      try {
        const signer = this.signerWallet.connect(this.relayProvider);
        const tx = await signer.sendTransaction(txRequest);
        this.cuMeter?.recordMethod("eth_sendRawTransaction");
        return { tx, submissionTarget: "relay" };
      } catch (error) {
        this.log.error({ cycleId, error }, "relay submission failed");
        if (!publicAllowed) {
          throw error;
        }
      }
    }

    if (publicAllowed && this.provider) {
      const signer = this.signerWallet.connect(this.provider);
      const tx = await signer.sendTransaction(txRequest);
      this.cuMeter?.recordMethod("eth_sendRawTransaction");
      return { tx, submissionTarget: "public" };
    }

    throw new Error("no available submission path for executor");
  }

  private rejectReason(candidate: ExecutionCandidate, route: RouteRuntimePlan): string | undefined {
    if (this.allowedBorrowTokens && !this.allowedBorrowTokens.has(candidate.borrow_token.toLowerCase())) {
      return "borrow token not allowlisted";
    }

    if (this.allowedProfitTokens && !this.allowedProfitTokens.has(route.profitTokenLower)) {
      return "profit token not allowlisted";
    }

    if (this.maxBorrowAmount > 0n && BigInt(candidate.borrow_amount) > this.maxBorrowAmount) {
      return "borrow amount above configured maximum";
    }

    if (this.maxRouteHops > 0 && route.swaps.length > this.maxRouteHops) {
      return "route hop count above configured maximum";
    }

    for (const swap of route.swaps) {
      if (this.allowedRouteKinds && !this.allowedRouteKinds.has(swap.kind)) {
        return `route kind ${swap.kind} not allowlisted`;
      }

      if (this.allowedAdapters && !this.allowedAdapters.has(swap.adapter.toLowerCase())) {
        return "adapter not allowlisted";
      }

      if (this.allowedRouters && !this.allowedRouters.has(swap.router.toLowerCase())) {
        return "router not allowlisted";
      }
    }

    return undefined;
  }

  private parseAddressSet(value?: string): Set<string> | undefined {
    if (!value) {
      return undefined;
    }

    const normalized = value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);

    return normalized.length > 0 ? new Set(normalized) : undefined;
  }

  private parseRouteKindSet(value?: string): Set<SwapRouteConfig["kind"]> | undefined {
    if (!value) {
      return undefined;
    }

    const validKinds = value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry): entry is SwapRouteConfig["kind"] => entry === "v2" || entry === "v3" || entry === "one_inch");

    return validKinds.length > 0 ? new Set(validKinds) : undefined;
  }

  private signerForTarget(target: "public" | "relay") {
    if (!this.signerWallet) return undefined;
    const provider = target === "relay" ? this.relayProvider ?? this.provider : this.provider ?? this.relayProvider;
    if (!provider) return undefined;
    return this.signerWallet.connect(provider);
  }

  private submissionDisabledReason(): string | undefined {
    if (!this.contractAddress) {
      return "executor contract address is not configured";
    }
    if (!this.profitRecipient) {
      return "executor profit recipient is not configured";
    }
    if (!this.provider) {
      return "public RPC_URL is required for gas estimation and confirmation tracking";
    }
    if (!this.signerWallet || !this.nonceCoordinator) {
      return "executor signer is not configured";
    }
    if (!this.allowedBorrowTokens || this.allowedBorrowTokens.size === 0) {
      return "borrow-token allowlist is not configured";
    }
    if (!this.allowedProfitTokens || this.allowedProfitTokens.size === 0) {
      return "profit-token allowlist is not configured";
    }
    if (!this.allowedAdapters || this.allowedAdapters.size === 0) {
      return "adapter allowlist is not configured";
    }
    if (!this.allowedRouters || this.allowedRouters.size === 0) {
      return "router allowlist is not configured";
    }
    if (!this.allowedRouteKinds || this.allowedRouteKinds.size === 0) {
      return "route-kind allowlist is not configured";
    }
    if (this.maxBorrowAmount <= 0n) {
      return "max borrow amount must be greater than zero";
    }
    if (this.maxRouteHops <= 0) {
      return "max route hops must be greater than zero";
    }
    if (this.maxGasCostWei <= 0n) {
      return "max gas cost must be greater than zero";
    }
    if (this.maxCumulativeEstimatedLossWei <= 0n) {
      return "max cumulative estimated loss must be greater than zero";
    }
    if (this.submissionMode === "relay_only" && !this.relayProvider) {
      return "private relay RPC URL is required for relay_only submission";
    }
    if (this.submissionMode !== "relay_only" && !this.allowPublicMempool) {
      return "public mempool submission is not explicitly allowed";
    }

    return undefined;
  }

  private recordFailure(kind: "dropped" | "reverted"): void {
    this.metrics.totalFailures += 1;
    this.metrics.consecutiveFailures += 1;
    if (kind === "dropped") {
      this.metrics.dropped += 1;
      return;
    }

    this.metrics.reverted += 1;
  }

  private async maybePause(reason: string): Promise<void> {
    const droppedFailures = this.metrics.dropped;
    const revertedFailures = this.metrics.reverted;
    const totalFailures = droppedFailures + revertedFailures;
    this.metrics.totalFailures = totalFailures;

    if (this.maxConsecutiveFailures > 0 && this.metrics.consecutiveFailures >= this.maxConsecutiveFailures) {
      await this.pause(`circuit breaker triggered: ${reason} (consecutive failures)`);
      return;
    }

    if (this.maxTotalFailures > 0 && totalFailures >= this.maxTotalFailures) {
      await this.pause(`circuit breaker triggered: ${reason} (total failures)`);
    }
  }

  private async maybePauseOnEstimatedLoss(reason: string): Promise<void> {
    if (this.maxCumulativeEstimatedLossWei <= 0n) {
      return;
    }

    const cumulativeEstimatedLossWei = this.cumulativeEstimatedNetWei < 0n ? -this.cumulativeEstimatedNetWei : 0n;
    if (cumulativeEstimatedLossWei >= this.maxCumulativeEstimatedLossWei) {
      await this.pause(`circuit breaker triggered: ${reason} (cumulative estimated loss)`);
    }
  }

  private transactionCostWei(receipt: { fee?: bigint | null; gasUsed: bigint; gasPrice?: bigint | null }): bigint {
    if (receipt.fee !== undefined && receipt.fee !== null) {
      return receipt.fee;
    }

    return receipt.gasUsed * (receipt.gasPrice ?? 0n);
  }

  private estimatedNetProfitWei(record: ExecutionRecord, txCostWei: bigint): bigint | undefined {
    if (!this.wrappedNativeToken || record.borrowToken.toLowerCase() !== this.wrappedNativeToken) {
      return undefined;
    }

    return BigInt(record.expectedProfit) - txCostWei;
  }

  private applyEstimatedNet(value?: bigint): void {
    if (value === undefined) {
      return;
    }

    this.cumulativeEstimatedNetWei += value;
  }

  private async readProfitRecipientBalance(token: string): Promise<bigint | undefined> {
    if (!this.provider || !this.profitRecipient) {
      return undefined;
    }

    const contract = new Contract(token, ExecutorClient.erc20BalanceAbi, this.provider);
    const balance = await contract.balanceOf(this.profitRecipient);
    this.cuMeter?.recordMethod("eth_call");
    return BigInt(balance);
  }

  private async realizedProfitTokenDelta(record: ExecutionRecord): Promise<bigint | undefined> {
    if (record.profitRecipientBalanceBefore === undefined) {
      return undefined;
    }

    const currentBalance = await this.readProfitRecipientBalance(record.profitToken);
    if (currentBalance === undefined) {
      return undefined;
    }

    const before = BigInt(record.profitRecipientBalanceBefore);
    return currentBalance >= before ? currentBalance - before : 0n;
  }

  private async pause(reason: string): Promise<void> {
    if (this.paused) {
      return;
    }

    this.paused = true;
    this.pauseReason = reason;
    this.log.error({ reason }, "executor paused");
    await this.writeJournal({
      timestamp: Date.now(),
      event: "paused",
      cycleId: "system",
      reason,
      details: {
        consecutiveFailures: this.metrics.consecutiveFailures,
        totalFailures: this.metrics.totalFailures,
      },
    });
  }

  private async writeJournal(entry: ExecutionJournalEntry): Promise<void> {
    await mkdir(dirname(this.journalPath), { recursive: true });
    await appendFile(this.journalPath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private async writeOutcome(entry: ExecutionOutcomeEntry): Promise<void> {
    await mkdir(dirname(this.outcomePath), { recursive: true });
    await appendFile(this.outcomePath, `${JSON.stringify(entry)}\n`, "utf8");
  }
}
