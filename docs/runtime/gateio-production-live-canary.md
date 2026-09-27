# Gate ProductionSpine bounded canary (G6)

This is a one-shot executable, not an autonomous runtime or live-readiness proof.
Implementation and offline fixtures do not verify credential rotation/permissions,
production connectivity, or ProductionSpine Live performance. Real execution requires
a separate explicit authorization. G3 TestNet receipts are not ProductionSpine Live receipts.

## Safe default

After the ordinary build, `node dist/bin/gateio-production-live-canary.js` prints a
sanitized `NOT_ARMED` receipt and exits 2. No credential callback or network is invoked.
The source executable is also usable with the existing TypeScript runner.

## Explicit contract for a separately authorized run

All flags use `--name=value`, except the standalone `--execute`. Unknown or repeated
flags are denied. No settings are discovered from environment variables, dotenv, a
home directory, credential vault, or default paths.

- `--execute`, `--expected-head=<40-character SHA>`, `--environment=live`,
  `--symbol=ETH_USDT` are mandatory. TestNet and other symbols are denied.
- `--account-id=<explicit identity>`, `--journal=<absolute existing journal path>`,
  and `--max-notional-usd=<positive operator cap>` are mandatory. The cap is a ceiling,
  not the OPEN amount; OPEN uses factual minimum contracts, multiplier and mark price.
- The journal must have a live/account-bound baseline, no existing OMS orders, and
  a current legitimate policy. The launcher never generates a policy or a FLAT baseline.
  Missing facts, expired policy, foreign positions or failed reconciliation stop execution.
  Do not fabricate a baseline, relabel a TestNet journal, or copy another account's history.
  Live baseline/policy provisioning is a separate operational prerequisite, not implemented here.
- `--permission-read=true`, `--permission-trade=true`, `--permission-withdraw=false`,
  `--permission-rotated=true` are mandatory independent, non-secret operator attestations.
  They are not a substitute for checking exchange-side key permissions/rotation.
- `--credential-file=<explicit absolute path>` selects a JSON object with `apiKey` and
  `secretKey`. No file is created by this phase. Programmatic callers can instead inject
  a credential provider. Only fake credentials are used in G6 tests.
  Before any credential content read, the CLI resolves the file, current checkout, and
  **all** Git worktrees to canonical real paths. Files inside/equal to any worktree root
  are denied, including tracked/ignored files and outside links into a checkout.
  An inside link is accepted only if its real target is outside every worktree.
  Failure to enumerate or canonicalize any root is a denial, not a reduced protected set.

HEAD, clean worktree, executable/repository identity and permission gates run before
credential loading. Repository identity is rechecked before production composition.
Keep the mutable journal outside the checkout so its updates cannot dirty source control.
No credential, header, signature, raw exchange message/body, secret length or secret hash
is included in the receipt. The stdout receipt contains status and canonical quantities;
quantity fields are underlying-asset units, not native Gate contract counts.

## Existing authorities and budgets

The chain is ProductionRuntimeOwner → ProductionSpine → executeThroughGateway →
Risk → OMS → Gate adapter/client. Recovery and every reconciliation use that same
spine. The internal observation port exposes only the latest capture already used
by reconciliation; it cannot acquire truth, mutate orders or grant readiness.

The existing `GateIoG3RunBudget` implementation is reused by the live binding:
one OPEN, one CLOSE, at most one reduce-only emergency cleanup; 3 total POSTs and
zero POST retries. All reads and mutations share the same run budget. Limits are
8 account acquisitions, 2 instrument acquisitions, 3 current-order attestations,
2 ambiguity reconciliations, and 54 total wire requests. These are ceilings, not targets.
No polling, timer, scheduler, replenishment, second transport or strategy loop is added.

After a mutation failure, a fresh reconciliation is mandatory. Verified FLAT means
stop without cleanup. Attributed, reconciled non-flat exposure permits one exact
reduce-only cleanup through Risk/OMS. Unknown/contradictory/active-order state never
authorizes blind cleanup. A confirmed successful cleanup yields `FAIL_CLEANED_UP`,
never `PASS`. Cleanup failure is not retried.

Before OPEN, `PARTIAL_CLOSEABILITY_PREFLIGHT` uses fresh instrument facts and the existing
adapter's supported ETH contract lattice: quantum 0.1 with decimal sizing, 1 otherwise.
The factual minimum must itself be a valid OPEN quantity and must not exceed that quantum;
the quantum must also normalize exactly for CLOSE/emergency_exit. Minimum 2 with integer
sizing is therefore denied (`CANARY_PARTIAL_RESIDUAL_NOT_CLOSEABLE`) before any mutation.
Minimum 1 integer and minimum 0.1 decimal are supported. No venue exception for sub-minimum
reduce-only orders is assumed, and the ordinary adapter's minimum-size guard is unchanged.

G5 still owns requested/cumulative/remaining quantities and delta application. A partial
is never treated as full, rounded up, or labeled FLAT. A nonterminal order blocks another
order. Normal mode denies a used journal; never delete history or invent a replacement baseline.

## Explicit recovery-only mode

`--execute --recovery-only` retains the exact-head, clean-tree, live/ETH, permissions,
configuration, credential containment and post-credential repository recheck gates.
It accepts the existing used journal, recovers through the same Owner/Spine, then requires
fresh reconciliation. It never creates an OPEN (or proof CLOSE) intent and cannot fall
through into normal mode. There is no synthetic baseline/policy or alternate authority.

- Factual FLAT: `RECOVERY_FLAT`, zero POSTs.
- Attributed, reconciled NONFLAT with matching local/exchange quantities and no active
  orders: at most one exact reduce-only `emergency_exit` through the same gateway/Risk/OMS.
  Existing recovery, reconciliation and market readiness gates still apply.
- After cleanup, obtain fresh reconciliation. Confirmed FLAT yields `RECOVERY_CLEANED_UP`,
  **not** canary `PASS`. Failure retains NONFLAT/UNKNOWN and is never retried.
- Unknown, contradictory, external or active-order facts: zero POSTs and STOP.

Recovery has proof budget 0, cleanup/total budget 1, POST retry 0, and the same finite
54-request ceiling. It does not relax sizing: an already uncloseable historical residual
is reported, not enlarged or falsely flattened. Normal OPEN remains prohibited on a used
journal even after recovery. Each recovery invocation requires separate explicit execution
authorization; it is not an automatic retry loop.

Only full proof completion with fresh reconciled final FLAT yields `PASS` (exit 0).
The two verified recovery-only statuses also exit 0, but do not certify canary completion.
Every other outcome exits 2. Any success with injected offline wire fixtures is offline
evidence only, never proof of real connectivity.
