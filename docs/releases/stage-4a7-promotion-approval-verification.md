# Stage 4A7 — Detached Promotion Approval Verification

## Objective

Verify that a Stage 4A6 promotion artifact received enough valid approvals from an explicit public-key
trust policy. The verifier is offline and pure. It neither creates nor loads private keys and it does
not activate a strategy.

## Signed contract

External signers sign the exact bytes returned by `makePromotionApprovalSigningPayload()`. The payload
is domain-separated with `CloddsBot:PromotionApproval:4A7-R1` and binds:

- approval contract version;
- Stage 4A6 `artifactId`;
- Stage 4A5 `decisionId`;
- approver identity and key identity;
- issue and expiry timestamps.

Only detached Ed25519 signatures are accepted. The repository exposes verification and payload
serialization; it intentionally exposes no signing or private-key API.

## Explicit trust policy

Callers must provide all policy decisions:

- `minApprovals`;
- `requiredApproverIds`;
- `maxAttestationAgeMs`;
- `trustedApprovers`, each binding one `keyId` to an `approverId` and Ed25519 public key.

There are no default approvers, keys, quorum, or validity period. Invalid policies throw fail-closed.
Unknown attestations are rejected rather than silently ignored.

## Verification order

1. Reverify the complete Stage 4A6 artifact and re-evaluate its Stage 4A5 promotion decision.
2. Require the decision status to be `promote`.
3. Validate artifact, decision, identity, key, and time bindings.
4. Verify each detached signature.
5. Reject duplicate approver attestations and count distinct verified identities only.
6. Enforce required identities and quorum.

`nowMs` is an explicit input, so tests and audit replay do not depend on wall-clock timing.

## Safety boundary

Stage 4A7 does not choose real approvers, register production public keys, generate or store private
keys, configure GitHub OIDC, sign artifacts, persist approval attestations, or connect an approval to
Paper, Testnet, Live, exchange, account, order, or strategy activation paths. Those actions require a
separate identity/key-custody decision.

## Acceptance

- adversarial tests cover quorum, required identities, key binding, payload changes, bad signatures,
  artifact and decision binding, validity windows, duplicate approvals, rejected decisions, corrupted
  artifacts, invalid policies, deterministic output, and caller ownership;
- focused and canonical tests, typecheck, build, runtime smoke, security policy, and diff check pass;
- fresh remote CI and Security pass before ordinary merge;
- target branch merge commit and tree are verified after merge.
