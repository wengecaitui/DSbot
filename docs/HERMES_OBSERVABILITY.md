# Hermes Observable-Behavior Monitor

This document defines the O1 core and O2 realtime adapters for DSbot (the repository is
still named CloddsBot during the controlled rename transition).

## Scope

O1 provides:

- a versioned `ObservableAgentEvent` contract;
- risk and evidence classification;
- recursive secret redaction and command hashing;
- normalization of raw adapter events;
- append-only daily JSONL audit files;
- an in-memory state projector;
- an adapter-based monitor lifecycle;
- a dry-run-first stdin CLI.

O2 adds opt-in, read-only adapters for Hermes logs, runtime state, process and
port health, Git state, and workspace file events. It is not connected to the
Gateway or the trading production entry point.

## Safety boundaries

- The monitor is outside the Fast Trading Path.
- `TradingEventBus` remains a trading-domain bus and is not used as an audit
  ledger.
- `ReportStore` remains the market-bias store and is not reused.
- Importing `src/observability` performs no I/O and starts no process.
- The CLI is dry-run by default. Disk writes require `--write`.
- Realtime mode starts only when `--realtime` is supplied and stops on Ctrl+C,
  SIGTERM, or the optional `--duration` deadline.
- Log tailing starts at the current end of each file, so historical logs are
  not replayed on startup.
- Raw commands are reduced to SHA-256 digests.
- Common token, key, password, cookie, authorization, and secret fields are
  redacted before projection or persistence.
- Ledger write failures are reported and rethrown.

## CLI

Dry-run normalization:

```powershell
'{"source":"git","action":"status.observed"}' |
  npm run monitor:hermes -- --run-id bootstrap
```

Explicit local persistence:

```powershell
'{"source":"git","action":"status.observed"}' |
  npm run monitor:hermes -- --write --root .runtime-observability
```

Events are appended to:

```text
.runtime-observability/events/YYYY-MM-DD.jsonl
```

The runtime directory is ignored by Git.

## O2 realtime mode

Dry-run monitoring until Ctrl+C:

```powershell
npm run monitor:hermes -- --realtime
```

Short verification run:

```powershell
npm run monitor:hermes -- --realtime --duration 10000 --no-files
```

Explicit append-only persistence:

```powershell
npm run monitor:hermes -- --realtime --write --root .runtime-observability
```

Default Windows Hermes sources are under
`%LOCALAPPDATA%/hermes`. Override them with `--hermes-home <dir>`. The default
runtime probes are gateway state, the Hermes Desktop process, the stable
gateway port 8642, and `http://127.0.0.1:8642/health`. Additional
ephemeral Desktop/backend ports are intentionally not treated as required
health dependencies.

Adapters emit an initial evidence snapshot and then emit only observable
changes. Filesystem output excludes `.git`, `node_modules`, `dist`, the audit
directory, and the Windows-reserved `nul` path.

Individual adapters can be disabled with `--no-logs`, `--no-runtime`,
`--no-git`, or `--no-files`. `--all-log-lines` is intentionally opt-in because
it can produce high-volume and less structured output.

## Windows scheduled-task deployment

The repository includes deployment tooling, but installing a task is an
explicit production-state change. Build and inspect the proposed task first:

```powershell
npm.cmd run build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  scripts/observability/install-hermes-monitor-task.ps1 -WhatIf
```

The default `AtLogOn` mode runs as the current interactive user, restarts after
failures, and does not store credentials. It is suitable for an always-logged-in
workstation. For unattended restart after a reboot, use `-TriggerMode AtStartup`;
this uses the current user with Task Scheduler's local-only S4U logon and may
require an elevated shell. S4U does not provide network credentials, which is
compatible with this monitor's local-only data sources.

Install and start only after production approval:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  scripts/observability/install-hermes-monitor-task.ps1 `
  -TriggerMode AtStartup -StartNow
```

Verify the registered task, Gateway, and dashboard:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  scripts/observability/test-hermes-monitor-task.ps1
```

Rollback stops and unregisters only the scheduled task. Audit ledgers and task
operation records under `.runtime-observability` are deliberately preserved:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  scripts/observability/uninstall-hermes-monitor-task.ps1
```

Registration, start, and removal actions append structured records to
`.runtime-observability/operations/task-operations.jsonl`.

## O3 extension points

O2 adapters implement `ObservableEventSourceAdapter`:

- `HermesLogAdapter`
- `FileSystemWatcher`
- `GitWatcher`
- `ProcessWatcher`
- `HermesRuntimeAdapter`

Approval correlation, alert policies, retention, dashboards, and a long-lived
service supervisor remain O3 work.

## O3 local dashboard

Start the read-only realtime dashboard:

```powershell
npm run monitor:dashboard
```

Then open `http://127.0.0.1:8765`. The page uses Server-Sent Events and shows
runtime health, Gateway state, active agents, Git state, risk/source counts,
and a filterable evidence timeline. It binds only to loopback, uses restrictive
browser security headers, exposes GET-only endpoints, and remains dry-run by
default.

The dashboard script enables `--quiet`, so the terminal shows the ready URL,
warnings, and a short shutdown summary instead of streaming every JSON event.

Use a different local port or stop automatically:

```powershell
npm run monitor:dashboard -- --dashboard-port 8877 --duration 60000
```

The dashboard process must remain running while the page is open. Ctrl+C stops
the monitor, closes SSE clients, and releases the port. Persistence is still
explicit through `--write`.

O3 currently provides the local live view plus in-memory alert and approval-ID
correlation. `ID_PRESENT` means an approval reference was observed; it does not
independently verify that approval. External policy files, retention controls, authentication for
non-loopback access, and service supervision remain future work.

### O3.2 alerts and approval correlation

The in-memory alert engine now identifies:

- unhealthy runtime, process, port, or health probes;
- Hermes error, crash, exception, and timeout log signals;
- Git HEAD changes;
- R2 and above events without an observable `approvalId`;
- R2 and above events that carry an approval correlation.

Alerts are deduplicated by rule, action, and target within a configurable time
window. Repeated alerts increment `occurrences` rather than flooding the UI.
Warning and critical alerts are also written to stderr. This is evidence
correlation only: an absent `approvalId` does not prove an action was
unauthorized, and a supplied ID does not independently prove approval validity.

The Dashboard shows the latest alert stream and approval correlation state.
Alert state is memory-only and disappears when the monitor exits. Automatic
acknowledgement, external notifications, retention deletion, and OS service
installation remain disabled.

### Project Control Center

The existing loopback Dashboard is the DSbot Project Control Center rather than
a separate project website. It answers these questions first:

1. Is Hermes healthy?
2. Is a task observably active?
3. Which task ID is producing activity?
4. What observable stage has been reached?
5. What needs the user's attention?

The Control Center never converts observations into a subjective completion
percentage. Delivery uses only `PLANNED`, `IMPLEMENTING`, `LOCAL_VERIFIED`,
`PUSHED`, `PR_OPEN`, `REMOTE_CI_VERIFIED`, `MERGED`,
`INTEGRATION_VERIFIED`, `CLOSED`, or `BLOCKED`. GitHub or local-test evidence
that cannot be read remains visibly unavailable and does not become a pass.

`/api/project` exposes the current capability, task, observable agent identity,
worktree, branch, commit, changed files, pull request, local test exit codes,
remote CI, blockers, next action, event timeline, integration head, promoted
strategy count, and fail-closed Replay/Shadow/Paper/Testnet/Live approvals.
The endpoint verifies repository identity and never grants approval.

Run a configured local gate through
`npm run control-center:run -- --gate <gate-id> <exact configured command>`
when its exit code should be visible in the Dashboard. The wrapper rejects
unknown IDs or command substitutions, requires a clean worktree before the
command, and verifies that HEAD and tracked state remain unchanged afterward.
Each result is bound to its before/after SHA in an ignored runtime artifact.
`LOCAL_VERIFIED` requires every configured local gate to pass on the same clean
SHA; one arbitrary successful command is insufficient.

The page supports manual refresh, a raw-evidence view, activity filters, search,
evidence dialogs, and a redacted collaboration handoff. These interactions
affect only the browser view; they cannot start, stop, approve, or modify Hermes
actions.

Apache DevLake, Grafana, and the Infinity datasource are an optional local
analytics companion configured under `deployments/control-center`. DevLake
owns historical GitHub delivery analytics; Grafana visualizes those analytics
and the read-only DSbot API. Neither replaces the Dashboard as the project
truth source. A GitHub credential and DevLake blueprint must be configured by
the operator before history is collected.

### Evidence-driven remediation advice

Each actionable alert can produce a read-only remediation card containing the
current diagnosis, possible impact, safe investigation steps, verification
criteria, and whether approval is required. Recommendations are rule-based and
preserve the source alert/event IDs. Repeated alerts update the same card.

No card offers automatic repair. An observed error does not prove its root
cause, so the monitor must not restart processes, edit configuration, reset
Git, or patch code from a keyword match. Users can copy a recommendation for
review or handoff; execution remains a separately approved task.

Adapters emit `RawObservableEvent` objects only. Normalization, redaction,
ordering, persistence, and state projection remain owned by the O1 core.
