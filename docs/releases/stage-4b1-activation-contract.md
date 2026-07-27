# Stage 4B1 — Strategy Activation Contract

## Classification

`OFFLINE ACTIVATION CONTRACT ONLY`

`BLOCKED: NO PROMOTED STRATEGY`

`NOT APPROVED FOR PAPER, TESTNET OR LIVE`

This stage defines a readiness-review contract. It neither imports nor calls a broker, exchange, order, Paper, Testnet, Live, execution, or runtime activation entry point.

## Real decision

The verifier recomputes the five Stage 4A inputs from their exact serialized JSON, checks every self-digest and cross-artifact identifier, and observes four candidates with zero promotion-eligible strategies. The only permitted real path is:

```text
INACTIVE → ELIGIBILITY_CHECKED → ACTIVATION_BLOCKED
```

The committed artifact contains no activation request. `paperApproved`, `testnetApproved`, `liveApproved`, and `liveExecutionChanges` are all false. Stage 4A14 is rejected as a source.

## Contract boundary

- `ActivationEligibilityProof` binds the verified Stage 4A artifact IDs, counts, strategy/spec/version/semantic-family/lineage identity when a promoted candidate exists, and a deterministic reason.
- `ActivationRequest` permits only `PAPER_READINESS_REVIEW`. It is not approval and cannot activate a runtime.
- Detached Ed25519 approval binds the proof, request, full strategy identity, scope, approver/key IDs, and canonical validity interval. Production accepts public keys only.
- Consumed evidence must be an exact-once completed result for the same promotion and semantic family. Foreign, duplicated, incomplete, inherited/relabelled, or altered evidence fails closed.
- `ActivationStateMachine` has no `ACTIVE` state. `ACTIVATION_REVIEW_READY` means contract review readiness only.
- `AppendOnlyActivationAudit` validates its full hash chain before read or append and rejects tamper, sequence gaps, forks, replay, invalid transitions, and truncation when an expected tip is supplied.

## Reference isolation

Positive-path cryptographic tests use only objects labelled `REFERENCE TEST FIXTURE ONLY`. Their mode is `REFERENCE`, their successful status is `REFERENCE_CONTRACT_VERIFIED`, and production request/decision functions explicitly reject them. No reference fixture, signature, public/private key, or positive reference artifact is published by the workflow.

## Deterministic evidence

The committed JSON is regenerated from the target baseline `9f659d7a02a4c025b9cef86ad6fa855e00f99b15` and the exact Stage 4A artifacts. Its artifact ID is `b91977cd4fc1784b2575b34e8aea2ad6448f1d3df29b5f3ab38d0e21cbfd7380`.

GitHub Actions recomputes the artifact, runs the canonical validation suite, uploads only the source-free real blocked artifact plus a commit-bound subject, and creates OIDC-backed attestations for those subjects.
