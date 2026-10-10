# PR #172 dependency security repair

Original head: `4ca041188fde6400d4983960dd1446255696e52e`.
Prepared on local branch: `codex/pr172-dependency-security-fix` for PR #172.
The committed lockfile and overrides govern repository/source installations.
As with the repository's pre-existing overrides, npm does not inherit these
overrides when another project installs clodds as a dependency; a future npm
release needs its own resolved-dependency audit. This repair does not publish
an npm release or change live-trading readiness.
Validation environment: Node 22.23.3, npm 10.9.9, Python 3.12.14, Linux x64.

## Findings and locations

The original head's fresh full npm audit on 2026-10-10 reported **22 affected
package records** (18 moderate, 3 high, 1 critical), derived from **10 distinct
advisories**. These are affected dependency records, not 22 independent exploits.
Compared with the earlier 21-record workflow log, the database now also reports
five advisories in `music-metadata`. Installation and commit identity were not
the failing gates. Exception validation passed all 40 negative probes; both the
exception registry and audit allowlist remain empty.

| Priority | Dependency and location | Risk / exposure | Repair |
| --- | --- | --- | --- |
| 1 | `sharp` directly and through Transformers; `src/media/index.ts` accepts SVG and calls sharp for resizing/metadata | High; vulnerable librsvg can cause RCE under specified glibc Linux runtime conditions | Pin direct dependency and override to 0.35.5; bundled librsvg verified as 2.63.2 |
| 2 | `express -> proxy-addr`; `src/gateway/server.ts` uses `req.ip` in rate limiting | Critical advisory; exploit requires a problematic proxy trust configuration. No `trust proxy` configuration was found in repository runtime code | Override 2.0.8; test forged forwarded headers against short IPv4-mapped prefixes |
| 3 | `@whiskeysockets/baileys -> music-metadata`; WhatsApp integration in `src/channels/whatsapp/index.ts` | Moderate audio parser resource exhaustion/crash; an application-level malicious audio exploit was not demonstrated | Override 11.16.0; retain valid WAV parsing compatibility |
| 4 | `mammoth -> argparse` and `Transformers -> ONNX -> global-agent -> roarr -> sprintf-js`; Mammoth is loaded in `src/extensions/open-prose/index.ts` | Moderate unbounded numeric precision throws RangeError. Runtime dependencies are present; remote control of application format strings was not established | Private repository fork with bounded precision; verify all five installed consumers and actual Roarr/argparse/Mammoth behavior |
| 5 | `pino-pretty -> fast-copy`; `src/utils/logger.ts` enables pino-pretty | Moderate deeply nested copy exhaustion | Override 3.1.0; check cycle compatibility and controlled maximum-depth rejection |
| 6 | Workbench `Vite -> PostCSS -> source-map-js` | High source-map denial of service; original lock marks it as a dev dependency | Override 1.2.2; reject malicious section offsets and check valid map generation |

Advisories: [proxy-addr](https://github.com/advisories/GHSA-jqcg-44mw-7w3h),
[sharp](https://github.com/advisories/GHSA-wq5f-xc86-pv6w),
[sprintf-js](https://github.com/advisories/GHSA-hp3w-g68c-fv3c),
[fast-copy](https://github.com/advisories/GHSA-jggr-w7fw-pc2j),
[source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
The five music-metadata advisories are `GHSA-f94x-6692-553q`,
`GHSA-53v6-4h7p-p4gj`, `GHSA-jjpr-9cvf-cq55`, `GHSA-5gfj-9q3v-qfp3`,
and `GHSA-8j4c-6x6g-rq3j`.

## Workflow fixes

`audit-ci@7.1.0` supports `--skip-dev`; the former `--production` flag did not
exclude development dependencies. The script now uses a locked local audit-ci,
runs the dependency security regressions, and passes `--skip-dev`.
`source-map-js` is also repaired so that the full audit is clean.

The Security summary now uses `npm audit --omit=dev`, runs even after a failed
preceding step, and distinguishes valid vulnerability JSON from command/registry
errors. The preceding moderate-or-higher audit remains the enforcing gate.
Five shell cases verified clean results, vulnerability reporting, registry error,
command error, and invalid JSON. Checkout identity checks are unchanged.

`sprintf-js` has no upstream patched release as of this audit. See
`vendor/sprintf-js/README.md` for source provenance, license, the local precision
fix and maintenance/removal policy. Registry audit cannot assess this private
fork; its crash and consumer-resolution tests run before the registry audit in
every security job. No advisory was allowlisted.

## Minimal original-head reproduction

Use Node 22 and npm 10. In a separate local worktree:

```sh
git worktree add --detach ../DSbot-pr172-original 4ca041188fde6400d4983960dd1446255696e52e
cd ../DSbot-pr172-original
npm ci
npm run security:audit
npm audit --omit=dev --json
```

Audit results depend on the advisory database at execution time. The original
script audits dev dependencies as well because of its unrecognized flag.

## Validate the repair

```sh
npm ci
python -m pip install -r quant_engine/requirements.txt
npm run security:audit
npm audit --json
npm run security:audit:python
npm run ci
```

Risk order: patched native SVG library and proxy trust boundary; formatter crash
payloads and all consumers; audio/logger compatibility and source maps; production
and full audits plus exception guards; TypeScript/Python tests and production
build. This checks both the intended security behavior and dependency compatibility.

Verified: clean npm ci; correct installed versions and consumer resolution;
40/40 negative exception probes; 10/10 dependency security regressions; production
and full npm audits at zero; Python audit with no known vulnerabilities; 992 Python
tests; workflow summary 5/5 cases; vendor source/license included in npm pack preview.
The complete packed clodds archive also installed successfully into an isolated
consumer project; the packaged CLI help command was checked separately.

Full CI validation passed with Node 22: TypeScript checks; 4,567 passing Node
tests, zero failures and three existing skips (4,570 discovered tests / 423
suites / 211 files); 992 Python tests; TypeScript and workbench production builds.
Only the managed proxy warning code described below was suppressed for this run.

The managed environment emits `UNDICI-EHPA` on Node startup. A full test attempt
had exactly one failure because a pre-existing no-argument CLI test requires empty
stderr. That suite passed 60/60 after suppressing only this warning code with
`NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--disable-warning=UNDICI-EHPA"`.
The proxy and network restrictions were retained; project code was not changed
to weaken the assertion. Existing Node engine warnings from two SDKs requiring
Node 24 remain separate from the audited vulnerabilities.
