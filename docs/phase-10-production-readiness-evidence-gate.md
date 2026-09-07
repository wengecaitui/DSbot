# Phase 10 — Production Readiness Evidence Gate

Phase 10 aggregates exact-head observations from the repository's existing CI,
Security, reference infrastructure, indicator asset, Stage 4B2, Stage 4B3, and
Stage 4B4 workflows. It does not generate a second proof or receipt. Each
observation identifies the existing workflow and, where applicable, the
existing artifact contract and subject digest.

The caller supplies one 40-character `candidateHead` and an explicit UTC
`evaluationTime`. Every required observation must be complete, successful,
fresh, and bound to that exact head. Missing, failed, stale, duplicated,
unknown, malformed, or mixed-head evidence makes the evidence set invalid.
The gate does not resolve `latest`, `current`, or a default branch.
Evidence is also bounded by a fixed 24-hour maximum age, so a caller-supplied
validity timestamp cannot extend an observation indefinitely.

The result is deterministic and immutable. Its states are:

- `EVIDENCE_INVALID`: the required evidence set is not usable.
- `BLOCKED`: the evidence set is valid but an activation-decision blocker is
  present.
- `READY_FOR_ACTIVATION_DECISION`: a human may consider a later, separate
  activation decision.

The maximum result grants no production, Testnet, or Live authority. Those
authority fields are always `false`.

Security exceptions are read from the exact-head Security observation. Every
present exception remains a blocker. Before its expiry it is classified as
active; at and after its expiry it is classified as expired and remains a
blocker because expiration is not resolution. The current
`GHSA-528h-pc64-c93x` `stream-json` exception therefore yields `BLOCKED` even
when all evidence is valid.

The current INT64 JavaScript safe-integer limitation and PythonBridge parallel
startup timing instability remain visible as warning-only debt. The gate does
no network, storage, or process I/O and does not change research or trading
runtime authority.
