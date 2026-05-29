# AWS Setup Guide

This guide sets up the arbitrage bot on an Ubuntu AWS server with:

- Dashboard supervisor on `127.0.0.1:9090`
- Bot control-plane API on `127.0.0.1:9091`
- Bot process managed inside `tmux` session `bot`
- Dashboard supervisor managed inside `tmux` session `dashboard`
- Executor starting paused by default

Do not expose ports `9090` or `9091` publicly. Use an SSH tunnel from your laptop.

## 1. Connect To AWS

From Windows PowerShell:

```powershell
ssh -i .\frost.pem ubuntu@YOUR_AWS_PUBLIC_DNS
```

Example:

```powershell
ssh -i .\frost.pem ubuntu@ec2-54-198-129-209.compute-1.amazonaws.com
```

## 2. Install System Dependencies

```bash
sudo apt update
sudo apt install -y git curl build-essential gcc g++ make pkg-config libssl-dev tmux jq
```

## 3. Install Node.js 24

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash
source ~/.bashrc
nvm install 24
nvm use 24
node -v
npm -v
```

Expected:

```text
node v24.x
npm 11.x
```

## 4. Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustc --version
cargo --version
```

If Rust warns that `cc` is missing, run:

```bash
sudo apt install -y build-essential gcc g++ make pkg-config libssl-dev
```

## 5. Clone The Repo

```bash
cd ~
git clone -b chore/upgrade-deps https://github.com/fangfrost3-dot/Multiple-Hop-Arbitrage.git
cd ~/Multiple-Hop-Arbitrage
```

If the repo already exists:

```bash
cd ~/Multiple-Hop-Arbitrage
git pull origin chore/upgrade-deps
```

## 6. Install And Build

```bash
cd ~/Multiple-Hop-Arbitrage
npm --prefix control-plane install
npm run build:rust
npm run build:control-plane
```

Optional: regenerate the allowlisted semi-dynamic V3 fee-tier routes before building:

```bash
npm run generate:routes:dry
npm run generate:routes
npm run build:control-plane
```

The generator reads `control-plane/config/route-generator.fork.json`, checks configured token pairs and Uniswap V3 fee tiers against live RPC liquidity, then updates `pools.fork.json` and `routes.fork.json`. It does not allow arbitrary runtime routes.

Root `npm install` is not required for running the live control-plane on AWS.

## 7. Create The Private Key File

```bash
cd ~/Multiple-Hop-Arbitrage/control-plane
mkdir -p secrets
nano secrets/executor.key
chmod 600 secrets/executor.key
```

Inside `secrets/executor.key`, put only the private key:

```text
0xYOUR_PRIVATE_KEY
```

No quotes. No `EXECUTOR_PRIVATE_KEY=` prefix.

Important: if this key has ever been pasted into chat, screenshots, or logs, rotate it before funding it with meaningful ARB.

## 8. Create AWS `.env`

Create:

```bash
cd ~/Multiple-Hop-Arbitrage/control-plane
nano .env
```

Paste this and replace placeholders:

```env
RUST_BINARY=../rust-core/target/release/rust-core

RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
WS_RPC_URL=wss://arb-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
PRIVATE_RELAY_RPC_URL=
EXECUTOR_SUBMISSION_MODE=public_only
EXECUTOR_ALLOW_PUBLIC_MEMPOOL=false

MULTICALL3_ADDRESS=0xcA11bde05977b3631167028862bE2a173976CA11
ARBITRUM_NODE_INTERFACE_ADDRESS=0x00000000000000000000000000000000000000C8
ARBITRUM_L1_FEE_PADDING_BPS=1500

POOL_CONFIG_PATH=./config/pools.fork.json
ROUTE_CONFIG_PATH=./config/routes.fork.json

ONE_INCH_API_KEY=
ONE_INCH_API_BASE_URL=https://api.1inch.dev

CANDIDATE_NOTIFICATION_WEBHOOK_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_MESSAGE_THREAD_ID=
ERROR_ALERTS_ENABLED=true
ERROR_ALERT_COOLDOWN_MS=300000
ERROR_ALERT_TIMEOUT_MS=5000
CANDIDATE_NOTIFICATION_MIN_EXPECTED_PROFIT=0
CANDIDATE_NOTIFICATION_COOLDOWN_MS=0
CANDIDATE_NOTIFICATION_TIMEOUT_MS=5000

RPC_MONITOR_INTERVAL_MS=15000
RPC_MONITOR_TIMEOUT_MS=5000

# The dashboard supervisor uses 9090.
# The bot API runs behind it on 9091.
METRICS_PORT=9091
WS_PORT=8080

STREAM_MAX_BLOCK_GAP=20
STREAM_REORG_LOOKBACK_BLOCKS=12
STABLE_POLL_INTERVAL_MS=0
# Deeper 500k-5m routes are mostly Uniswap V3 fee-tier routes.
# Keep this enabled so those pools are refreshed after bootstrap.
V3_POLL_INTERVAL_MS=3000

MIN_EXPECTED_PROFIT=0
ENGINE_MIN_CYCLE_EDGE_PROFIT_BPS=0
ENGINE_MAX_HOPS=3

EXECUTOR_PRIVATE_KEY=
EXECUTOR_PRIVATE_KEY_PATH=./secrets/executor.key
EXECUTOR_ALLOW_INLINE_PRIVATE_KEY=false
EXECUTOR_PAPER_TRADING=false
EXECUTOR_PAPER_VALIDATE_CALL=true
EXECUTOR_PAPER_JOURNAL_PATH=./logs/paper_trades.jsonl

EXECUTOR_CONTRACT_ADDRESS=0x7c6c58D4cDE75389FCe701920eD261961f48F3B0
EXECUTOR_PROFIT_RECIPIENT=YOUR_PROFIT_WALLET_ADDRESS

EXECUTOR_JOURNAL_PATH=./logs/executions.jsonl
EXECUTOR_OUTCOME_PATH=./logs/outcomes.jsonl

EXECUTOR_ALLOWED_BORROW_TOKENS=0x912CE59144191C1204E64559FE8253a0e49E6548,0x82aF49447D8a07e3bd95BD0d56f35241523fBab1,0xaf88d065e77c8cC2239327C5EDb3A432268e5831,0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8,0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1
EXECUTOR_ALLOWED_PROFIT_TOKENS=0x912CE59144191C1204E64559FE8253a0e49E6548,0x82aF49447D8a07e3bd95BD0d56f35241523fBab1,0xaf88d065e77c8cC2239327C5EDb3A432268e5831,0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8,0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1
EXECUTOR_ALLOWED_ADAPTERS=0x45dA5A260ff01210F2f0151E0DcE82217380D914,0xA7039C2583E1b5a340D82d0F8E7DA696e01D7a87
EXECUTOR_ALLOWED_ROUTERS=0xc873fEcbd354f5A56E00E710B90EF4201db2448d,0xE592427A0AEce92De3Edee1F18E0157C05861564,0x1b02da8cb0d097eb8d57a175b88c7d8b47997506
EXECUTOR_ALLOWED_ROUTE_KINDS=v2,v3
EXECUTOR_BLOCKED_CYCLE_IDS=uni-wbtc-weth-v3-3000->uni-weth-wbtc-v3-500

# Keep these conservative for first live tests.
# Set nonzero values before unpausing.
EXECUTOR_MAX_BORROW_AMOUNT=0
EXECUTOR_MAX_ROUTE_HOPS=2
EXECUTOR_MIN_PROFIT_REALIZATION_BPS=0
EXECUTOR_MAX_PROFIT_BPS=500
EXECUTOR_START_PAUSED=true
EXECUTOR_MAX_CONSECUTIVE_FAILURES=3
EXECUTOR_MAX_TOTAL_FAILURES=10
EXECUTOR_MAX_CUMULATIVE_ESTIMATED_LOSS_WEI=0

WRAPPED_NATIVE_TOKEN=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
MAX_GAS_COST_WEI=0
EXECUTOR_CONFIRMATIONS=1
EXECUTOR_REPLACEMENT_BUMP_BPS=1500
EXECUTOR_STUCK_TX_TIMEOUT_MS=45000
EXECUTOR_MAX_REPLACEMENTS=3
EXECUTOR_MAX_INFLIGHT=1
EXECUTOR_KILL_SWITCH_PATH=
```

Keep `EXECUTOR_START_PAUSED=true`.

Before unpausing, set nonzero risk caps either in `.env` and restart, or from the dashboard runtime settings:

- `EXECUTOR_MAX_BORROW_AMOUNT`
- `MAX_GAS_COST_WEI`
- `EXECUTOR_MAX_CUMULATIVE_ESTIMATED_LOSS_WEI`

Runtime dashboard settings apply immediately but reset after process restart unless also saved in `.env`.

## 72-Hour Paper Trade Run

Use this mode when you want the bot to scan, pass candidates through route/risk/profit gates, and write accepted paper trades without signing or submitting transactions.

In `~/Multiple-Hop-Arbitrage/control-plane/.env` set:

```env
EXECUTOR_PAPER_TRADING=true
EXECUTOR_START_PAUSED=false
EXECUTOR_PAPER_JOURNAL_PATH=./logs/paper_trades.jsonl
EXECUTOR_ALLOW_PUBLIC_MEMPOOL=false
```

Paper mode does not need live submission credentials to submit transactions. Keep the dashboard private through SSH tunnel or VPN.

Check paper mode after restart:

```bash
curl -s http://127.0.0.1:9091/status | jq '{paper:.executor.paperTrading,paused:.executor.paused,paperTrades:.executor.metrics.paperTrades,pools:.engine.tracked_pools,routes:.engine.tracked_cycles}'
```

Watch the paper trade journal:

```bash
tail -f ~/Multiple-Hop-Arbitrage/control-plane/logs/paper_trades.jsonl
```

After 72 hours, summarize route activity:

```bash
jq -r '[.cycleId,.borrowToken,.borrowAmount,.expectedProfit] | @tsv' ~/Multiple-Hop-Arbitrage/control-plane/logs/paper_trades.jsonl | sort | uniq -c | sort -nr | head -50
```

## 9. Start The Dashboard Supervisor

The supervisor stays alive on `9090` and can start/stop/restart the bot in `tmux`.

```bash
cd ~/Multiple-Hop-Arbitrage
tmux new -s dashboard
DASHBOARD_PORT=9090 BOT_METRICS_PORT=9091 npm run run:dashboard
```

Detach:

```text
Ctrl+b then d
```

Check sessions:

```bash
tmux ls
```

Expected:

```text
dashboard: ...
```

## 10. Open Dashboard From Windows

Open a Windows PowerShell tunnel:

```powershell
ssh -i .\frost.pem -L 9090:127.0.0.1:9090 ubuntu@YOUR_AWS_PUBLIC_DNS
```

Keep that window open.

Then open:

```text
http://127.0.0.1:9090/dashboard
```

The dashboard API field should show:

```text
http://127.0.0.1:9090
```

## 11. Start The Bot From Dashboard

In the dashboard, click:

```text
Start Bot
```

The supervisor starts the bot in:

```text
tmux session: bot
```

The bot itself listens on:

```text
127.0.0.1:9091
```

The dashboard proxies:

```text
9090/status -> 9091/status
9090/settings -> 9091/settings
9090/pause -> 9091/pause
9090/resume -> 9091/resume
```

## 12. Attach / Detach

From SSH:

```bash
tmux attach -t bot
```

Detach without stopping:

```text
Ctrl+b then d
```

From the dashboard:

- `Attach` shows/copies the attach command.
- `Detach` detaches tmux clients from the `bot` session.

A browser cannot safely attach to an interactive SSH terminal directly. Use SSH for true terminal access.

## 13. Verify Health

From AWS:

```bash
curl -s http://127.0.0.1:9091/status | jq '{
  paused:.executor.paused,
  inflight:.executor.metrics.inflight,
  rpcHealthy:.rpc.publicRpc.healthy,
  rpcMs:.rpc.publicRpc.lastLatencyMs,
  pools:.engine.tracked_pools,
  cycles:.engine.tracked_cycles,
  updates:.stream.poolUpdatesTotal,
  updateAgeMs:.stream.lastUpdateAgeMs,
  reorg:.stream.reorg,
  cuMonth:.alchemyCu.estimatedCuPerMonth
}'
```

Expected safe state:

```text
paused = true
inflight = 0
rpcHealthy = true
pools = 26
cycles > 5
updates increasing over time
reorg.detectedTotal = 0 or recoveryTotal catches up
```

## 14. Runtime Settings From Dashboard

Dashboard controls:

- Max borrow amount
- Max route hops
- Min expected profit
- Max gas cost wei
- Max cumulative loss wei
- Max inflight

Recommended first test settings:

```text
Max route hops: 2
Max inflight: 1
Max borrow amount: small nonzero cap
Max gas cost wei: nonzero cap
Max cumulative loss wei: small nonzero cap
Min expected profit: nonzero after dry observation
```

Do not unpause with zero risk caps.

## 15. First Live Test

Before unpausing:

1. Rotate any exposed private key.
2. Fund the executor/deployer wallet with small ARB for gas.
3. Confirm the dashboard safety checklist is green.
4. Keep `max inflight = 1`.
5. Use a small max borrow amount.

Then:

1. Click `Unpause`.
2. Watch for 5-10 minutes.
3. Click `Pause`.
4. Review logs:

```bash
cd ~/Multiple-Hop-Arbitrage/control-plane
tail -n 100 logs/executions.jsonl
tail -n 100 logs/outcomes.jsonl
```

## 16. Restart / Stop

Dashboard buttons:

- `Start Bot`
- `Stop Bot`
- `Restart Bot`

Manual commands:

```bash
tmux kill-session -t bot
```

Restart dashboard supervisor:

```bash
tmux kill-session -t dashboard
cd ~/Multiple-Hop-Arbitrage
tmux new -s dashboard
DASHBOARD_PORT=9090 BOT_METRICS_PORT=9091 npm run run:dashboard
```

## 17. Update Deployment

When changes are pushed:

```bash
cd ~/Multiple-Hop-Arbitrage
git pull origin chore/upgrade-deps
npm --prefix control-plane install
npm run build:rust
npm run build:control-plane
```

Restart via dashboard or:

```bash
tmux kill-session -t bot
```

Then click `Start Bot` in the dashboard.

## 18. Troubleshooting

### Dashboard Does Not Load

Check supervisor:

```bash
tmux ls
curl http://127.0.0.1:9090/supervisor/status
```

Check Windows tunnel:

```powershell
Invoke-RestMethod http://127.0.0.1:9090/supervisor/status
```

### Bot Does Not Start

Attach dashboard supervisor:

```bash
tmux attach -t dashboard
```

Check whether `tmux` is installed:

```bash
tmux -V
```

Check `.env`:

```bash
cd ~/Multiple-Hop-Arbitrage/control-plane
grep -E 'METRICS_PORT|EXECUTOR_PRIVATE_KEY_PATH|RUST_BINARY|RPC_URL|WS_RPC_URL' .env
```

### Bot Says Private Key File Missing

Use Linux path:

```env
EXECUTOR_PRIVATE_KEY_PATH=./secrets/executor.key
```

Not a Windows path.

### Port Conflict

Supervisor should use `9090`.

Bot should use `9091`.

If old bot is still on `9090`:

```bash
tmux kill-session -t bot
```

Then start dashboard supervisor again.

### Low Pool Updates

Low updates do not automatically mean slow RPC. It can mean tracked pools were quiet.

Watch:

```bash
watch -n 10 "curl -s http://127.0.0.1:9091/status | jq '{rpcMs:.rpc.publicRpc.lastLatencyMs,pools:.engine.tracked_pools,cycles:.engine.tracked_cycles,updates:.stream.poolUpdatesTotal,ageMs:.stream.lastUpdateAgeMs,lag:.stream.publicBlockLag}'"
```

### RPC Latency Target

Current acceptable ranges:

```text
< 100ms    good
100-250ms  acceptable
250-500ms  weak
500ms+     poor for live arbitrage
```

To chase `20ms`, test different AWS regions and/or dedicated RPC providers. Do not optimize this before private submission, risk caps, and route quality are handled.
