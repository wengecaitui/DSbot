# Stage 5.2 — Dataset and Leakage Control

This stage freezes and audits the public market-data inputs used by Stage 5 research.

## Source and scope

- Provider: Binance public market-data API (`https://data-api.binance.vision/api/v3/klines`).
- Authentication: none. No API key, account, order, balance, Paper, Testnet, or Live endpoint is used.
- Symbols: `BNB/USDT`, `BTC/USDT`, `ETH/USDT`, and `SOL/USDT`.
- Interval: `5m`, UTC, with exact five-minute continuity and invalid/duplicate/missing rows rejected.
- TRAIN: `[2025-07-02T00:00:00Z, 2026-04-01T00:00:00Z)`.
- VALIDATION: `[2026-04-01T00:00:00Z, 2026-07-01T00:00:00Z)`.
- LOCKED_TEST: `[2026-07-01T00:00:00Z, 2026-07-29T00:00:00Z)` remains `SEALED_UNOPENED`, has access count zero, and has no recorded row hashes.

The fetch command exposes only TRAIN and VALIDATION. Raw Kline rows are written to an explicitly selected private directory outside the repository and are never committed. The checked-in public receipt contains only range metadata, validation outcomes, and SHA-256 digests; it contains neither local paths nor raw rows.

## Leakage contract

The split is chronological. Indicators use completed bars only, decisions are made at the current close, and execution is at the next open. Scalers may be fit on TRAIN only. Cross-split fitting, future labels as features, unfinished higher-timeframe candles, and LOCKED_TEST selection are forbidden.

The frozen geometry is:

- purge: 96 bars;
- embargo: 96 bars;
- warm-up: 100 bars;
- feature lookback: 100 bars;
- label horizon: 1 bar.

Warm-up and embargo tails are present in the raw inputs but excluded from scored intervals. A gap, duplicate, malformed timestamp, illegal OHLC relationship, non-finite value, or row-count mismatch fails the audit closed.

## Reproduction and evidence

The local evidence command downloads only TRAIN and VALIDATION to a private directory:

```powershell
python scripts/run-stage-5-dataset-audit.py `
  --source-commit <audited-code-commit> `
  --evaluation-spec <authoritative-stage-5.1-json> `
  --private-output-dir E:\Workplace\.private-proofs\cloddsbot-stage-5\dataset-v1 `
  --manifest-output tests\fixtures\stage-5-dataset\stage-5-dataset-manifest.json
```

CI does not re-download mutable market data. It downloads the authoritative Stage 5.1 constitution, checks the committed receipt's canonical bytes and complete contract, uploads that exact receipt, and creates an OIDC-backed attestation. The receipt binds the audited implementation commit; the workflow artifact is additionally bound to the exact PR or target commit that verified it.

This is offline research evidence only. It is not a Paper fill, exchange fill, real order, or authorization to run any trading environment.
