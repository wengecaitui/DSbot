# Stage 4A8 — Reference Infrastructure Proof

## Classification

```text
REFERENCE INFRASTRUCTURE PROOF ONLY
NOT A REAL STRATEGY BACKTEST
NOT APPROVED FOR PAPER, TESTNET OR LIVE
```

This stage proves the reproducibility and GitHub provenance plumbing around the Stage 4A4 through
Stage 4A6 validation chain. It does not evaluate a production strategy and grants no execution
permission.

## Bound subject

The JSON proof subject binds the repository and exact source commit, workflow path, deterministic
dataset descriptor and generated-data SHA-256, validation configuration SHA-256, reference simulator
identity and source SHA-256, phase ledger, Stage 4A6 promotion artifact, and an outer proof digest.

Verification regenerates every reference bar, reruns causal Walk-Forward and Final Holdout, reruns the
Stage 4A5 decision, verifies the Stage 4A6 artifact, and compares the ledger and complete output. A
changed commit, dataset, configuration, simulator identity, ledger, report, decision, artifact digest,
or outer digest fails closed.

The reference simulator makes deterministic non-zero hypothetical trades solely to prevent a
zero-trade implementation from creating a misleading green result. Its metrics are not trading
evidence.

## GitHub provenance

The dedicated workflow checks out the exact bound source commit, performs a clean `npm ci`, reruns the
canonical validation suite, builds the project, generates and re-verifies the proof, uploads the exact
JSON subject, and invokes `actions/attest` with `id-token: write` and `attestations: write`.

GitHub's attestation binds the subject file digest to the workflow identity using a short-lived OIDC
identity. Verification is performed with:

```text
gh attestation verify reference-infrastructure-proof.json -R wengecaitui/DSbot
```

Phase B keeps private translated strategy sources and historical data out of this public repository.
Only non-reversible strategy/data digests and non-sensitive proof metadata may cross that boundary.
