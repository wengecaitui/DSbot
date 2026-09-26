# Gate G4: local production composition

This is an offline-tested binding, not a launch authorization or autonomous live runtime.

ProductionRuntimeOwner accepts exchange gateio, mode limited-live,
an explicit environment testnet or live, and only the ETH/USDT / ETH_USDT
market scope. The separate injected gateIo dependency must match the exact
account/environment and supply a credential, wire function, clock and finite
GateIoG3RunBudget. No default Gate binding, secret loading or ambient fetch exists.
Construction performs no I/O. Test credentials and recording functions prove both
environment branches without contacting either exchange host.

## Ownership and truth

The owner creates exactly one existing ProductionSpine. The composition module
creates only the existing L0 read transport, L1A foundation, G2 execution client,
G1 adapter and G3H truth port. There is no G3 runner, extra Kernel, OMS, position
store, risk evaluator or reconciliation engine.

Normal intent admission remains executeThroughGateway -> PreTradeRiskGateway ->
OmsCore -> GateIoFuturesExecutionAdapter -> GateIoFuturesExecutionClient.
Owner never calls the client mutation method. The existing protective path retains
the same OMS; it receives the same post-submit truth check.

Gate canonical instrument facts alone feed adapter sizing. Gate ticker observations
feed the owner market runtime and preserve exchange and observation time. Caller
risk limits can only tighten observed Gate total/available capacity. No reference
venue provides Gate balances, instruments, positions or orders.

Recovery uses recoverAndStart; all comparisons use reconcileRecoveredState /
the existing reconcile engine. The Gate truth wrapper fixes the existing first
flat capture's historical-trade boundary, but NEVER seeds FLAT or repairs a position.
An empty local journal still yields MISSING, and entry is rejected. Recovered
nonflat state, orders, missing history or external activity must actually reconcile;
no historical boundary is invented to hide them.

G3H order attestation is verification only. The existing reconciliation engine
additionally compares the Kernel journal's exact fill quantities/prices with
external fills, so net-flat exposure cannot conceal conflicting open/close fills.
Delayed personal trades can converge without applying a second fill.

## Gates and limits

Boot does not grant LIVE_READY or submit orders. Explicit activation still requires
verified recovery, current reconciliation and fresh collector-originated Gate
market facts. Current observation age (including future-clock rejection) is checked
again at activation and entry, not just an ever-observed boolean.

Each Gate entry obtains current truth through the same reconciliation gate.
Every OMS attempt through the spine's shared OMS facade revokes prior reconciliation,
then performs fresh post-submit reconciliation, even after ambiguity or rejection.
A failed observation never erases a factual local fill or authorizes another entry.
Mutation/verification in-flight checks prevent overlapping submissions; there is no
POST retry. Shutdown does not leave the OMS facade authorized.

This is deliberately a bounded session: the injected budget is not replenished,
and the collector publishes only its initial factual observation. There is no timer,
polling, autonomous refresh, new strategy policy, or guessed position bootstrap.
Stale data and budget exhaustion fail closed. Continuous operation and restart
history retention are not certified by this local binding.

The live transport's optional budget parameter uses the SAME L0 implementation;
its GET allowlist, signer, raw-int64 parser and production provenance are unchanged.
The market bridge now retains the collector's receivedAt rather than replacing
it with a later wall clock.

PARTIAL_FILL_LIFECYCLE=P1 remains inherited. Partial execution stays
SUBMISSION_UNKNOWN/unreconciled; it is not represented as a full fill or safe flat
account. No autonomous-live readiness is claimed.
