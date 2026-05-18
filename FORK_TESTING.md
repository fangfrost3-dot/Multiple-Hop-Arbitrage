# Fork Testing

Use the local `.env` file to point Hardhat at a real archive-capable RPC endpoint:

```dotenv
FORK_RPC_URL=https://your-rpc-endpoint
FORK_BLOCK_NUMBER=optional-fixed-block
```

The fork smoke test is intentionally minimal. It verifies that Hardhat can:

- create a forked `hardhatMainnet` network
- expose funded local signers on top of the fork
- mine a transaction successfully

Run it with:

```powershell
npm run test:fork
```

Recommended workflow before live testing:

1. Pin `FORK_BLOCK_NUMBER` so test results are reproducible.
2. Replace `control-plane/config/pools.fork.json` with real pool addresses.
3. Replace `control-plane/config/routes.fork.json` with real routes and nonzero slippage guards.
4. Keep `EXECUTOR_START_PAUSED=true` in `.env` until end-to-end fork checks are complete.
5. Compare expected profit with realized execution outcomes before enabling live submission.
