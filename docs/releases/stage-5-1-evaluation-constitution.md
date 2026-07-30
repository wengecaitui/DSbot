# Stage 5.1 - Evaluation Constitution

Stage 5.1 freezes the research budget, data universe and time ranges, cost
assumptions, metrics, validation thresholds, locked-test rules, robustness
requirements, and promotion boundary before any Stage 5 market result is read.

The candidate space is the complete set of four Stage 4A12 derived candidates.
Their original strategy/spec identities and the Stage 4A13 consumed-evidence
lineage remain bound. A new ID cannot reset prior evidence consumption.

The frozen research universe is BNB, BTC, ETH, and SOL against USDT at five
minutes. Training and validation use only evidence later than the consumed
Stage 4A12 five-minute holdout. The locked interval is fixed to
`[2026-07-01T00:00:00Z, 2026-07-29T00:00:00Z)` and remains unopened at this
stage.

Costs include fees, adverse spread and slippage, a symmetric adverse funding
charge for the linear research proxy, and one-bar latency. Both baseline and
stress assumptions are frozen. Results cannot be used to reduce thresholds,
remove weak assets or periods, or add candidates.

```text
FROZEN_BEFORE_DATA_ACCESS
MAX_RESEARCH_ROUNDS=1
MAX_CANDIDATES_PER_ROUND=4
LOCKED_TEST_ACCESS_COUNT=0
OFFLINE_ONLY=true
PAPER_TESTNET_LIVE_CALLS=0
ACTIVATION_AUTHORIZED=false
RUNTIME_STARTED=false
PAPER_APPROVED=false
TESTNET_APPROVED=false
LIVE_APPROVED=false
```

The GitHub workflow downloads the exact target-branch Stage 5 entry artifact,
binds its raw bytes, reruns the canonical suite, uploads the canonical
constitution JSON, and creates an OIDC/Sigstore attestation.
