# Stage 4B4.2 — Durable Shadow Runtime

Status: implementation complete; remote merge evidence pending.

This stage is reference shadow infrastructure only. It is not approved for
Paper, Testnet, or Live use and cannot call exchange, execution, fill, or order
adapters.

## Runtime contract

The coordinator owns one state machine, intent boundary, append-only event
ledger, and snapshot store. An accepted observation follows one order only:

1. prepare an identity-bound, single-use boundary token without mutation;
2. durably append the verified event and observation to the hash-chained ledger;
3. commit the exact issued token to the in-memory boundary;
4. atomically persist a snapshot of the resulting state.

Any failure after durable processing begins enters `RECOVERY_REQUIRED` and
never returns success. Exact duplicates still pass through the ledger so an
external deletion, replacement, or same-size mutation cannot bypass integrity
verification.

## Restart and snapshot contract

Startup replays every verified ledger entry through the boundary while in
`SHADOW_READY`. Missing snapshots and valid stale ledger prefixes are rebuilt.
Malformed, tampered, future-sized, or mismatched snapshots are rejected and
move the coordinator to `RECOVERY_REQUIRED`.

Snapshots bind schema version, shadow state, ledger size, exact prefix digest,
last event and observation IDs, and boundary size into a deterministic ID.
They are canonical UTF-8 JSON with a trailing LF and use same-directory atomic
replacement. Write, fsync, close, rename, read-back, path, or content failures
are fail-closed. Pause, resume, and stop persist their resulting state.

## Module runtime contract

The previous `ES2022` plus `Bundler` compiler settings emitted extensionless
ES module imports that `node dist/...` could not resolve. The package has no
`type: module` declaration and its published entry points are executed directly
by Node, so this stage aligns output with that existing contract using CommonJS
and Node resolution. The built shadow barrel is loaded directly as the safe
runtime smoke.

## Verification

- shadow focused tests: 395 passed, 0 failed, 0 skipped;
- canonical suite: 2,469 passed, 0 failed, with 3 pre-existing explicitly
  skipped external-chain integration tests;
- Python quant suite: 46 passed, 0 failed;
- TypeScript typecheck: passed;
- build: passed;
- built shadow module smoke: passed;
- diff check and forbidden-source scan: passed.

The positive paths use reference fixtures only. No production promotion,
activation approval, Paper approval, Testnet approval, or Live approval is
created by this stage.
