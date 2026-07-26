# Stage 4A9 — Pine Asset Readiness and Gap Policy

This stage corrects the proof universe from an assumed ten strategies to the fourteen assets in `docs/all_indicators_pine_v2.txt`.

```text
INDICATOR ASSET READINESS PROOF
NOT A REAL STRATEGY BACKTEST
NOT APPROVED FOR PAPER, TESTNET OR LIVE
```

## Classification result

- 14 Pine assets are identified and bound to their Pine source, current Python implementation, and registry entry by SHA-256.
- 1 Pine asset is a direct strategy: TradeIQ Crazy Scalping. Its current registry counterpart, SmartOrderBlock, is explicitly a conceptual derivative rather than a faithful translation, so it is not real-Walk-Forward ready.
- 4 assets need an explicit lifecycle: Chandelier Exit, Fibonacci Entry Bands, Hull Suite, and UT Bot Alerts. Their Pine sources expose trade-intent alerts but do not unambiguously specify the complete entry/exit/reversal lifecycle.
- 9 assets are indicator components and must not be promoted into standalone strategies merely to increase the count.
- Consequently, the current real-Walk-Forward-ready count is 0. This is a fail-closed readiness result, not a zero-trade backtest.

The machine-readable proof is generated with `scripts/run-indicator-asset-audit.py`. Text identities use canonical UTF-8/LF bytes so Windows and Linux recompute the same digest. The artifact includes no Pine or Python source text and no host-specific private paths.

## Conservative lifecycle boundary

The generic adapter evaluates every closed bar even while flat, so the first entry cannot be suppressed by iterating only existing positions. Signals execute at the next bar open. This removes same-bar close/fill lookahead. Strategy-specific mappings remain blocked unless their Pine source uniquely determines target position, exit, reversal, and stop behavior.

## Historical-data gap policy

Gap handling is mandatory and explicit:

- `reject`: any interval mismatch fails the dataset before fold generation.
- `segment`: preserves every observed row, records every gap, and partitions the data into contiguous segments. It never fills or synthesizes bars.

Walk-Forward folds may only be constructed from a contiguous segment. The local private audit uses `reject` for gap-free 5-minute and 4-hour files. One-hour files require an explicit `segment` or `reject` choice and can never enter validation under an implicit fill policy.

The Python proof kernel applies the same isolation geometry as the validation contract: phase gaps are `max(purgeBars, labelHorizonBars)`, adjacent out-of-sample gaps are `max(embargoBars, labelHorizonBars)`, the final holdout gap is `max(purgeBars, embargoBars, labelHorizonBars)`, and feature lookback is excluded from eligible training indices.

## Proof boundary

The public OIDC attestation covers only the source-free readiness artifact and its commit binding. Private strategy code, private absolute paths, historical market data, and real backtest artifacts are not uploaded. A real strategy provenance attestation is permitted only after a faithful Python mapping and causal lifecycle pass this readiness gate.
