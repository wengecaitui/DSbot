# Stage 4A5-R1 — Fail-Closed Strategy Promotion Gate

## Objective

Consume a Stage 4A4 `ValidationReport` and an explicit `StrategyPromotionPolicy`, then produce an immutable, deterministic promotion decision. The gate is a pure decision boundary: it does not persist configuration, modify a strategy, place orders, or enable Paper, Testnet, or Live execution.

## Inputs

- `ValidationReport` with contract version `4A4-R8` and `selectionMode = causal-per-fold`.
- `StrategyPromotionPolicy` whose thresholds are all supplied by the caller. The gate has no hidden profitability, warning, or risk defaults.

Malformed policy values throw `INVALID_PROMOTION_POLICY:<field>`. Validation-report and performance failures return `status = reject` with ordered reason codes.

## Structural Gates

1. Both validation contract fields equal `4A4-R8`.
2. `reportId` is non-empty and selection mode is causal-per-fold.
3. The required minimum development-fold count is present.
4. Exactly one fold has `usedForDeployment = true`.
5. The deployment fold identifier, candidate ID, selected parameters, deprecated selected-parameter alias, and report deployment fields agree.
6. Every fold that selected parameters contains test metrics.
7. Final Holdout is a valid inclusive in-bounds range.
8. Final Holdout evaluation count is exactly one and metrics are present and finite.

## Explicit Policy Gates

- minimum development folds;
- maximum warnings and limitations;
- minimum Final Holdout trades;
- minimum Final Holdout net return;
- minimum Final Holdout Sharpe ratio;
- maximum Final Holdout drawdown.

Changing policy changes `decisionId`. Reordering equivalent policy fields does not.

## Output Ownership

The result, reason list, and copied deployment parameters are frozen. Caller-owned report parameters are not frozen or mutated. The output can be handed to a later persistence or approval stage without sharing mutable parameter references.

## Scope Boundary

R1 does not recompute `reportId`, because the current `ValidationReport` does not retain every identity input (notably `datasetHash`). It treats the Stage 4A4 report as the upstream validation artifact. Persisted artifact integrity, signature/attestation, approval workflow, and strategy activation are later stages.

R1 makes no live-execution change and exports no automatic activation path.

## Acceptance Criteria

- valid R8 report plus permissive explicit policy promotes;
- malformed policy throws fail-closed;
- every structural mismatch rejects with a stable reason code;
- every explicit threshold is independently enforced;
- decision identity is deterministic and policy-sensitive;
- output is immutable without freezing caller input;
- typecheck, focused tests, canonical tests, build, security, and runtime smoke pass;
- fresh remote CI and Security pass before merge.
