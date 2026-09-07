# Phase 10 — Production Readiness Evidence Gate

Phase 10 aggregates exact-head evidence from the repository's existing CI,
Security, reference infrastructure, indicator asset, Stage 4B2, Stage 4B3, and
Stage 4B4 workflows. It does not generate a second proof or receipt. A workflow
name, successful conclusion, run number, schema name, or arbitrary digest is a
caller assertion and cannot establish evidence validity.

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

Artifact-backed observations carry the exact JSON bytes and their digest. The
gate recomputes the byte digest and runs the existing in-memory Reference,
Stage 4B2, and Stage 4B3 reverifiers with the candidate-head binding. The
Indicator verifier requires repository files, and the Stage 4B4 verifier
requires its ledger and snapshot files. Their observations therefore fail
closed as `ARTIFACT_REVERIFICATION_UNAVAILABLE` inside this no-I/O gate. This is
an explicit trust boundary, not a substitute proof format.

CI and Security currently publish no repository-owned receipt that can be
authenticated offline. Their caller-created summaries therefore fail closed as
`UNVERIFIED_EXTERNAL_OBSERVATION`. A future positive result requires an existing
authenticatable repository artifact or a separately authorized boundary change;
adding `verified=true` or an equivalent flag is insufficient.

Security exceptions present in an observation remain blockers. Before expiry an
exception is classified as active; at and after expiry it is classified as
expired and remains a blocker because expiration is not resolution. Omitting
the current `GHSA-528h-pc64-c93x` `stream-json` exception cannot produce a ready
result. The gate carries a repository-owned fail-closed mirror of this current
exception, and its regression test binds that mirror to
`security/audit-exceptions.json`. The unauthenticated Security observation is
also independently invalid. Phase 10 does not claim that an empty caller array
proves the exception was resolved.

The current INT64 JavaScript safe-integer limitation and PythonBridge parallel
startup timing instability remain visible as warning-only debt. The gate does
no network, storage, or process I/O and does not change research or trading
runtime authority.
