# Stage 4B4.3 — Shadow Runtime Proof

This stage produces a deterministic artifact from the real Stage 4B4.2 shadow
ledger, snapshot, boundary, state machine, and coordinator contracts.

The workflow creates one explicitly labelled `REFERENCE TEST FIXTURE ONLY`
trade intent, records the intent observation without calling an execution
adapter or fill simulator, reaches `STOPPED`, and then hashes the exact ledger
and snapshot bytes. The proof binds the source commit, Stage 4B4.2
implementation baseline, ordered event and observation IDs, ledger tip, and
snapshot ID. Re-running with identical bytes and source commit produces the
same proof ID and artifact bytes. Changing an approval field or evidence byte
causes verification to fail closed.

The uploaded JSON is attested through GitHub OIDC. It is intentionally marked:

```text
REFERENCE SHADOW INFRASTRUCTURE PROOF ONLY
NOT A STRATEGY BACKTEST
NOT APPROVED FOR PAPER, TESTNET OR LIVE
```

`zeroAdapterCalls` is fixed to `0`; `paperApproved`, `testnetApproved`, and
`liveApproved` are fixed to `false`. This stage neither authorizes nor starts a
Paper, Testnet, or Live environment and does not assert that any strategy is
promoted.
