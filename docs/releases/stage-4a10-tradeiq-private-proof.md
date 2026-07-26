# Stage 4A10 — TradeIQ Private Real-Data Proof

This stage closes the generic execution semantics required by the only native Pine strategy in the fourteen-asset collection.

## Public contract changes

- Strategy decisions receive an immutable position context (`flat`, `long`, or `short`, plus entry and stop prices).
- Pine entries can attach a positive stop distance.
- Signals are evaluated on closed bars and execute at the next bar open.
- Protective stops execute against subsequent OHLC ranges, including conservative adverse opening-gap fills.
- Fee and slippage basis points are explicit Walk-Forward configuration fields and are included in report identity.
- Flat bars are evaluated normally, so a strategy can generate its first entry without an existing position.

These are generic interfaces. The public repository does not contain the private faithful TradeIQ adapter or historical data.

## Pine semantic audit

The original TradeIQ Pine v5 source defines complete `strategy.entry`, `strategy.exit`, and `strategy.close` behavior. The registered `SmartOrderBlock` Python component remains a conceptual derivative and is not treated as a translation.

The other lifecycle-incomplete assets remain blocked:

- Chandelier Exit and UT Bot Alerts do not uniquely specify exit-versus-reversal handling.
- Hull Suite cross alerts do not define order lifecycle or risk exits.
- Fibonacci Entry Bands exposes entries, TP-like rejection alerts, and bounce alerts, but does not uniquely define their position interaction.

No rules are synthesized for those four assets.

## Proof boundary

The faithful TradeIQ translation and full real-data proof bundle remain local and private. The public workflow may attest only a source-free digest receipt containing identities, call counts, and aggregate metrics. That receipt is not remote recomputation of the private strategy or data.

```text
REAL STRATEGY BACKTEST PROOF
NOT STRATEGY PROMOTION
NOT APPROVED FOR PAPER, TESTNET OR LIVE
```
