# RN Arbitrage Stack

This repository is organized around three layers:

- `control-plane/`: Node.js process for websocket ingest, logging, RPC fallback, and forwarding pool updates to Rust.
- `rust-core/`: hot-path engine for in-memory pool state, cycle generation, pruning, and profitable-route detection.
- `contracts/`: Solidity execution layer with a flash-loan executor that can be driven by the off-chain engine.

Current supported execution/bootstrap shape:

- Solidity adapters for `UniswapV2`-style routers and `UniswapV3` single-hop routers
- RPC bootstrap for configured `v2`-family pools in the control plane
- optional `v2_factory` discovery that expands token sets into discovered pair addresses
- optional Multicall3 batching for pair discovery and reserve bootstrap
- websocket-backed V2 `Sync` ingestion for incremental reevaluation
- route-config-driven executor submission through the flash-loan contract

## Architecture

The intended responsibility split is strict:

- Node is not in the hot path.
- Rust owns live reserves, graph updates, pruning, simulation, and candidate generation.
- The Solidity contract only performs guarded execution and repayment logic.

Current scaffolded flow:

1. Node bootstraps pool snapshots and forwards incremental updates to the Rust process over stdio.
2. Rust maintains pool state in memory, prebuilds arbitrage cycles, and reevaluates only cycles touched by an updated pool.
3. Rust emits profitable candidates back to Node.
4. Node decides whether to encode and submit a flash-loan execution transaction.

## Repo Layout

- `contracts/FlashLoanExecutor.sol`: owner-gated flash-loan receiver with adapter-based swap steps and minimum-profit enforcement.
- `contracts/adapters/`: venue-specific adapters for router-driven swaps.
- `contracts/test/*`: lightweight mocks for ERC20s, DEX adapters, and a flash lender.
- `rust-core/src/`: state store, graph engine, pruning, simulator, and stdio message loop.
- `control-plane/src/`: Rust bridge, RPC bootstrap loader, configured pool parsing, executor hook, and runtime config.
- `control-plane/src/poolStream.ts`: websocket-based V2 reserve ingest with block-gap detection hooks.
- `control-plane/src/discovery.ts`: shared V2 discovery used by bootstrap and live ingest.
- `control-plane/config/pools.example.json`: example configured pool list for RPC bootstrap.
- `control-plane/config/routes.example.json`: example cycle-to-execution mapping used by the executor.

## Commands

```powershell
npm run build:contracts
npm run test:contracts
npm run build:rust
npm run run:rust
npm run build:control-plane
npm run run:control-plane
```

## Control Plane Config

Environment variables:

- `RUST_BINARY`: path to the Rust engine binary
- `RPC_URL`: JSON-RPC endpoint used for bootstrap reserve fetches
- `PRIVATE_RELAY_RPC_URL`: optional RPC endpoint used as the primary execution submission path
- `EXECUTOR_SUBMISSION_MODE`: one of `public_only`, `relay_preferred`, or `relay_only`
- `WS_RPC_URL`: websocket RPC endpoint used for live pool event ingestion
- `MULTICALL3_ADDRESS`: optional Multicall3 contract used for batched bootstrap reads
- `POOL_CONFIG_PATH`: JSON file listing configured pools
- `ROUTE_CONFIG_PATH`: JSON file mapping cycle ids to executable swap routes
- `METRICS_PORT`: HTTP port exposing `/healthz`, `/status`, `/metrics`, and `/resume`
- `STREAM_MAX_BLOCK_GAP`: block-gap threshold before the control plane flags replay/recovery need
- `MIN_EXPECTED_PROFIT`: candidate filter threshold before executor submission
- `EXECUTOR_PRIVATE_KEY`: signer used for sending execution transactions
- `EXECUTOR_CONTRACT_ADDRESS`: deployed `FlashLoanExecutor` address
- `EXECUTOR_PROFIT_RECIPIENT`: address that receives realized profits
- `EXECUTOR_JOURNAL_PATH`: append-only JSONL journal for submissions, replacements, confirmations, and risk rejections
- `EXECUTOR_OUTCOME_PATH`: append-only JSONL ledger for execution outcomes and estimated net results
- `EXECUTOR_ALLOWED_BORROW_TOKENS`: optional comma-separated borrow-token allowlist
- `EXECUTOR_ALLOWED_PROFIT_TOKENS`: optional comma-separated profit-token allowlist
- `EXECUTOR_ALLOWED_ADAPTERS`: optional comma-separated adapter allowlist
- `EXECUTOR_ALLOWED_ROUTERS`: optional comma-separated router allowlist
- `EXECUTOR_ALLOWED_ROUTE_KINDS`: optional comma-separated route kind allowlist such as `v2` or `v3`
- `EXECUTOR_MAX_BORROW_AMOUNT`: hard ceiling for candidate borrow size
- `EXECUTOR_MAX_ROUTE_HOPS`: hard ceiling for swap count per route
- `EXECUTOR_START_PAUSED`: boot the executor in a paused state
- `EXECUTOR_MAX_CONSECUTIVE_FAILURES`: auto-pause threshold for back-to-back failed txs
- `EXECUTOR_MAX_TOTAL_FAILURES`: auto-pause threshold for cumulative failed txs
- `EXECUTOR_MAX_CUMULATIVE_ESTIMATED_LOSS_WEI`: auto-pause threshold for cumulative estimated wrapped-native losses
- `WRAPPED_NATIVE_TOKEN`: token used for direct gas/profit comparison gates
- `MAX_GAS_COST_WEI`: hard upper bound on estimated tx gas cost
- `EXECUTOR_CONFIRMATIONS`: confirmations required before a tx is considered final
- `EXECUTOR_REPLACEMENT_BUMP_BPS`: fee bump used for rebroadcasting stuck transactions
- `EXECUTOR_MAX_INFLIGHT`: cap on concurrent pending execution txs

The current bootstrap loader supports `v2` pools with:

- pair address
- token orientation
- fee bps
- venue label

It also supports `v2_factory` entries with:

- factory address
- token set to scan pair combinations
- fee bps
- venue label

Live ingestion currently supports:

- websocket subscriptions to V2 `Sync` events
- pair-to-oriented-pool fanout for forward and reverse edges
- block-gap replay for missed V2 `Sync` logs with reserve-recovery fallback
- websocket reconnect and resubscription for V2 pools
- block-driven polling for configured two-coin stable pools
- block-driven polling for configured V3 pools using approximate reserve reconstruction

It does not yet include venue-perfect stable event decoding or tick-accurate V3 liquidity reconstruction.

Execution submission currently supports:

- route lookup by `cycleId`
- ABI encoding of executor plans
- dynamic route-data encoding for V2 and V3 adapters
- gas estimation and simple cost/profit gating
- signer-backed transaction submission with nonce management
- pending-tx rebroadcast with configurable fee bumps
- append-only execution journaling
- append-only outcome ledger with receipt-derived tx costs and estimated net profit for wrapped-native routes
- pre-submit risk gates for borrow-token allowlists, borrow size, and route hop count
- route-policy gates for profit tokens, adapters, routers, and route kinds
- executor circuit breaker with auto-pause on repeated failed transactions
- relay-aware execution submission with public-RPC fallback when configured
- HTTP status and Prometheus-style metrics endpoints

It does not yet include token-accurate realized PnL across arbitrary profit assets, venue-specific private relay integration, or advanced circuit breakers.

## Production Gaps

This repo is now a realistic foundation, not a finished mainnet bot. Before deploying capital, you still need:

- real DEX adapters and calldata builders per venue
- canonical Arbitrum pool discovery and multicall-based state bootstrap
- reorg handling and deterministic replay
- exact gas and L1 data fee modeling
- tx replacement, relay strategy, and post-trade reconciliation
- auth, secrets handling, observability, and kill switches
- hard simulation parity with each targeted AMM formula

If you skip those, the system is not production ready regardless of language choice.
