# Stage 4A6 — Immutable Promotion Artifact Persistence

## Contract

Stage 4A6 persists the complete offline evidence used by the Stage 4A5 promotion gate:

- the Stage 4A4 `ValidationReport`;
- the explicit `StrategyPromotionPolicy`;
- the resulting `StrategyPromotionDecision`;
- a canonical SHA-256 artifact identifier.

`PromotionDecisionArtifactStore` requires an explicit absolute directory. Each artifact is stored as
`<decisionId>.json`. It never uses `ReportStore`: that store is a mutable market-bias snapshot and is
not an append-only validation evidence store.

## Fail-closed behavior

- Artifact creation owns its snapshots and does not freeze caller inputs.
- Read re-runs the Stage 4A5 gate from the persisted report and policy.
- Read compares the re-evaluated decision and canonical artifact digest.
- Invalid JSON, malformed IDs, changed decisions, changed reports, and changed policies reject.
- A hard-link publish creates the final path without overwrite. Identical concurrent saves are
  idempotent; a different artifact sharing a decision ID raises `PROMOTION_ARTIFACT_COLLISION`.
- Missing artifacts return `null`; malformed existing artifacts never degrade to missing.

## Safety boundary

SHA-256 provides deterministic corruption and tampering detection only. It does not prove who created
or approved an artifact. Stage 4A6 does not manage signing keys, attest identities, implement an
approval workflow, activate strategy parameters, or connect to Paper, Testnet, Live, exchange, order,
or account paths.

## Acceptance

- focused and canonical tests cover round-trip, concurrency, overwrite prevention, tampering,
  traversal, malformed data, caller ownership, and reject-decision evidence;
- typecheck, build, runtime import smoke, security policy, and diff check pass;
- fresh remote CI and Security pass;
- the merged target commit is reverified in a clean detached worktree.
