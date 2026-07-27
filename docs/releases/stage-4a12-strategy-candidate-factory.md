# Stage 4A12 — Strategy Candidate Factory and Robustness Gate

Stage 4A12 creates new, explicitly derived strategy specifications from the
fourteen-asset component inventory. It does not change the Pine asset
classification or claim that indicator alerts are original trading rules.

```text
NEW DERIVED STRATEGY SPEC
PAPER READINESS REVIEW ONLY
NOT APPROVED FOR PAPER, TESTNET OR LIVE
```

## Candidate factory

The canonical `StrategySpec` binds `strategyId`, version, components, entry and
exit rules, position lifecycle, risk rules, timeframe, symbols, explicitly
enumerated parameters, warmup bars, next-open execution, cost model, and the
Pine/Python/registry digests of every source component. The strategy ID and
spec ID are deterministic hashes of the complete contract.

The first batch is deliberately bounded to four specifications and three
parameter sets per specification:

- trend plus stochastic entry confirmation;
- STC momentum plus trend filtering;
- mean reversion plus a trend guard;
- support/resistance proximity plus explicit risk exits.

All four are new derived contracts. They support flat-state first entry, long
and short positions, explicit signal exits, reversal, ATR stop-loss,
reward/risk take-profit, maximum holding bars, closed-bar decisions, and
next-open execution. If stop and take-profit are both touched within one bar,
the simulator resolves the stop first.

Chandelier Exit, Fibonacci Entry Bands, Hull Suite, and UT Bot Alerts remain
`needs-lifecycle` and `BLOCKED`. None is used in the first batch. The nine pure
indicators remain components rather than standalone strategies. TradeIQ and
its already consumed Stage 4A10 holdout are excluded from candidate fitting.

## Robustness and selection-bias control

Each of three expanding folds performs parameter selection on train data only.
Validation and test are evaluation-only and cannot replace the selected
parameters. Every specification reports all three parameter sets and records a
total selection count of nine. The train ranking uses median cross-market
return minus a deterministic dispersion penalty proportional to
`sqrt(2*log(selectionCount))`; it is a conservative selection-bias control, not
a claim of a formal p-value.

The matrix includes eight gap-free 5-minute datasets and BTC/ETH gap-free
4-hour datasets. Every dataset uses `reject` gap policy. No one-hour data is
used. Every fold is separated by purge/label-horizon and embargo gaps, and the
final holdout is separated from development before any selection occurs.

The gate evaluates:

- baseline and higher fee/slippage test performance;
- transaction count and bar-level mark-to-market drawdown;
- parameter perturbation stability without changing the frozen selection;
- positive-result consistency across all markets and both timeframes;
- one-shot final holdout performance for every candidate and every dataset.

The persistent private holdout ledger reserves all forty
strategy-by-dataset keys before evaluation. Reservation itself counts as
consumption. A duplicate key fails closed, and a crash cannot authorize a
retry.

## Real-data result

All four candidates completed the ten-dataset matrix and consumed their final
holdouts exactly once. None passed the complete robustness gate:

| Candidate | Holdout median return | Positive datasets | Trades | Max drawdown | Promotion eligible |
| --- | ---: | ---: | ---: | ---: | --- |
| Trend + stochastic | -4.6822% | 1/10 | 470 | 24.6255% | false |
| STC + trend | -2.2922% | 3/10 | 342 | 30.3889% | false |
| Mean reversion + trend | -6.9366% | 1/10 | 753 | 50.4662% | false |
| Support/resistance + risk | -7.4945% | 0/10 | 848 | 48.2602% | false |

The two latter candidates passed the pre-holdout checks but failed on the
untouched holdout. Their rules and parameters are therefore frozen as failed
Stage 4A12 evidence and must not be tuned against this holdout.

## Decision boundary

- Candidate strategy generation: complete.
- Real multi-market/multi-timeframe backtest: complete.
- Robustness passed: zero of four.
- Promotion eligible: zero of four.
- Paper approved: false.
- Testnet approved: false.
- Live approved: false.

The full report, trade digests, and holdout ledger remain in the private local
proof bundle. The public repository contains the canonical candidate manifest
and a source-free promotion decision receipt. GitHub OIDC attests only those
public artifacts and their commit bindings; it cannot recompute private market
data.
