# Gate G5: factual cumulative execution in the existing OMS

Base: `cabf124a6d1376d98d306b5898861ecec1ce981a`.
Implementation and validation are local/offline only. No new runtime, OMS,
position store, risk authority, reconciliation engine, credential loader or
transport is introduced. No Live/TestNet activation is granted.

## Quantities and events

The existing OMS journals `order.execution.prepared` before the adapter's POST:
canonical requested quantity, venue contract quantity, multiplier, deterministic
client text and reduce-only semantics. No secret is journaled. `SUBMITTED`,
`PARTIALLY_FILLED`, `FILLED`, `CANCELLED`, `REJECTED` and `SUBMISSION_UNKNOWN`
remain distinct; cancellation does not erase filled or remaining quantities.

The existing `execution.fill.confirmed` event carries only the newly proven delta,
plus its cumulative observation. The same deterministic transition validates
live application and journal replay. A duplicate cumulative observation emits
nothing; replaying an identical Kernel event also emits nothing. Quantity,
identity, timestamp, or cumulative-cost regression/conflict fails closed.
Incremental price comes from incremental factual cost, not the latest average
price applied to the entire position. Decimal arithmetic preserves genuine
nonzero residuals without lot rounding or epsilon-to-flat conversion.

## Truth, reconciliation and restart

The Gate truth port reuses the existing exact client-text lookup/parser. Durable
request facts allow the same GET after restart without submitting anything.
Pending orders may be observed again by an explicit reconciliation call; terminal
attestations are cached. Existing request caps and POST retry=0 are unchanged.
There is no timer, polling, retry loop or budget replenishment.

Exact order cumulative quantity, fresh Gate exposure, Kernel/OMS quantities and
any visible trade aggregation must agree. Absent history may lag; contradictory
visible history or unrelated new activity still fails closed. Trade convergence
does not cause an additional fill. Old journals without durable preparation do
not acquire guessed sizing or automatic repair authority.

ProductionSpine previews new deltas with the existing position arithmetic and
pure reconciliation engine, then asks the existing OMS to publish them. It does
not directly alter position state or call client mutation. Missing protection
does not erase factual fills, but the final reconciliation/activation gates still
deny readiness until protection is present. Unresolved orders deny new entries;
this does not globally prohibit factual reduce/close. Reduce-only request and
delta quantities are checked against factual exposure.

## Offline evidence and remaining boundary

Tests exercise the real Owner -> Spine -> Risk -> OMS -> Gate adapter/client
(injected fixture wire) -> truth -> reconciliation -> Kernel path: partial open,
multiple fills, duplicate observations, partial/IOC close, exact decimal residual,
restart recovery, multiple delayed trades, contradictory attribution/quantity,
external activity and reduce-only overfill prevention. G3/G4 and legacy venue
regressions remain required. The partial-fill implementation is not proof of
continuous production operation, exhaustive exchange history retention, a risk
ledger, autonomous operation, or a real ProductionSpine Live canary.

`READY_FOR_AUTONOMOUS_LIVE=false`.
