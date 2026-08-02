# DSbot Project Control Center analytics stack

The existing loopback DSbot Dashboard remains the authoritative project-state interface. Apache DevLake collects GitHub delivery history, and Grafana adds historical analysis plus a read-only Infinity view of the DSbot API. This stack cannot execute commands, grant trading approval, or activate Replay, Shadow, Paper, Testnet, or Live.

## Pinned components

- Apache DevLake `v1.0.3-beta15`
- Grafana `13.1.1`
- Grafana Infinity datasource `3.11.1`
- MySQL `8.0.46` pinned to the official multi-platform image digest

The pins were checked against the projects' official release pages. Review and update them deliberately; do not use floating `latest` tags.

## Start the read-only loop

1. Start the DSbot Dashboard from the repository root:

   ```powershell
   npm.cmd run monitor:dashboard -- --repo E:\Workplace\CloddsBot
   ```

2. Copy `.env.example` to `.env`, replace every placeholder with a locally generated secret, and keep `.env` untracked. The DevLake database password must be URL-safe because it is embedded in `DB_URL`.

3. Validate and start the containers:

   ```powershell
   docker compose --env-file .env config --quiet
   docker compose --env-file .env up -d
   ```

4. Open `http://127.0.0.1:4000`, create a GitHub connection, and provide a separate least-privilege token through DevLake Config UI. Do not copy the credential into this repository or the DSbot Dashboard. Create a blueprint for `wengecaitui/DSbot` covering commits, pull requests, reviews, Actions workflows and jobs.

5. Open `http://127.0.0.1:3002`. The provisioned `DSbot Project State` dashboard reads `http://host.docker.internal:8765/api/project`; the `Apache DevLake` datasource is available for historical panels.

Only loopback ports are published. MySQL is not exposed to the host. `host.docker.internal` is the only container-to-host path used for the DSbot API.

## Evidence and limitations

- Git and worktree facts come from local read-only Git commands.
- PR and CI facts come from the authenticated `gh` CLI. If unavailable, the API reports a data gap instead of success.
- Local test results come from observable test events or `.runtime-observability/control-center-tests.json`, bound to a commit SHA. Missing evidence remains visibly unavailable.
- DevLake needs a user-provided GitHub credential and an explicit blueprint before historical data exists.
- Docker Desktop/daemon must be running for container startup. Compose syntax can be validated without starting trading infrastructure.
- Grafana and DevLake are analysis surfaces, not approval authorities or project truth sources.

## Stop and rollback

```powershell
docker compose --env-file .env down
```

This preserves named volumes. Removing volumes is intentionally not part of the documented rollback because it destroys collected history.
