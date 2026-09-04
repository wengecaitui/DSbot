# Stage 4B / Stage 5 durable authority chain

## Purpose and boundary

The Stage 4B and Stage 5 proof workflows previously depended on GitHub Actions artifacts with 30-day retention. Those archives expired while their subjects remained long-lived validation authorities. This change moves transport and persistence to byte-exact Git subjects. It does not requalify evidence, create a new trust root, or substitute current state for a historical subject.

The mandatory offline gate is the committed Git blob plus its raw subject SHA-256, byte length, and historical semantic identity. A GitHub Actions artifact archive is only a transport container. Its archive digest, if ever recorded, must be named `artifactArchiveSha256`; it is not a `rawSha256` and is not used as subject authority here. A new same-repository attestation cannot replace an original historical root.

The machine-readable registry is `docs/releases/stage-4b-stage-5-durable-authority-bindings.json`. It records existing bindings and is not itself a new proof subject. `scripts/verify-durable-authority.py` performs the fail-closed offline verification before any existing generator or semantic verifier runs.

## Historical subjects

| Authority ID | Canonical path | Bytes | Raw subject SHA-256 | Historical producer run | Producer commit | Semantic identity |
| --- | --- | ---: | --- | ---: | --- | --- |
| `STAGE_4B1_ACTIVATION_ARTIFACT` | `docs/releases/stage-4b1-activation-contract.json` | 5358 | `4d474f9d357fa6fb7d584576a891c5916f4f7ca4166d82027dba8fb29947d4aa` | 30245529110 | `eee580cb7a25f67cb65aecd9a0a82f71b4921121` | artifact `f320f0e51ef6c0900a189dd7455d0c3ee77726bb4c6d1820d422d725629bf52e` |
| `STAGE_4A12_CANDIDATE_MANIFEST` | `docs/releases/stage-4a12-candidate-manifest.json` | 19849 | `3d110db1052b19ef76b4aabd571f2c610a5c68b2485d362a9dd50df61787e298` | 30235971008 | `4b34e6a58e0b7bf93774bc8f3055fea60e28117d` | manifest `7ba0079a9d0c12562562378d598372a46f4290adb527264a61558f9ed70201aa` |
| `STAGE_4B1_SUBJECT` | `tests/fixtures/stage-4b-closure/stage-4b1-subject.json` | 827 | `0ecc172079eb5a78f1733ccf9a332a188ba5f55ecd13586970450a25cafd8fb5` | 30245529110 | `eee580cb7a25f67cb65aecd9a0a82f71b4921121` | subject `6f86823399b0d7076d50d9cb6b563e46646a8d928e4e58b537505282783e99e7` |
| `STAGE_4B2_RECEIPT` | `tests/fixtures/stage-4b-closure/stage-4b2-receipt.json` | 952 | `5fefa5c1ddb025c94300e8b7dcb3b6d9dd5ba2e36a6d70e2ec10554d1d6a2453` | 30320628525 | `81b0980f4fee168075a52c6ebcb12eb50f382217` | receipt `64b15a8acef9b1ba6f16ff87f81d27fcf28fbf6b94424d059521a20702165785` |
| `STAGE_4B3_RECEIPT` | `tests/fixtures/stage-4b-closure/stage-4b3-receipt.json` | 1322 | `2e339f3fa9a8e02c7a0219248d54bcf5844591d20b35c8ffc24ed02777f9c55b` | 30365533078 | `e6bc1852f55d71fd897a513bb533085596a1a480` | receipt `18a7e928015ded178e5b48beaefff8cc29945e8e1d8329c4c03c58148a07ffa2` |
| `STAGE_4B4_PROOF` | `tests/fixtures/stage-4b-closure/stage-4b4-proof.json` | 1037 | `aa9b5e4715d9a3e9ba16dbed8a3bf77d11016b5c53f4bc12cc51d117ce2693c0` | 30525863496 | `9e0d9dafeead4ee22f38ae9e1f964cb15855da27` | proof `srp-3c1d24416252eefce4e7b6f43fdc5b79419a8a0970a8428f5c3f0877af8f46be` |
| `STAGE_4B_CLOSURE_AUDIT` | `tests/fixtures/stage-5-entry/stage-4b-closure-audit.json` | 1931 | `bae5d1d45d2d3d550efec9e18be813c054f98dc32d7b6ebab7d53e0ab094844a` | 30528115935 | `c33d56d8e295dc064fa971cfa2128aaac41705da` | closure `345432934555e1935388eb2193f6ef365e7f924fba5a668e399ca3f1db72705a` |
| `STAGE_5_ENTRY_GATE` | `tests/fixtures/stage-5-evaluation/stage-5-entry-gate.json` | 755 | `b33502d272d7c4bd13c9863518600bb6a1c19cf6e52bf150161f4d494c296c28` | 30530350135 | `818770767eab0a7173292b614b6e699a9ce310a1` | gate `987f264ee5079dc623c52edef254e89dc2dab09b18084b238c2d31bd629553d5` |
| `STAGE_5_EVALUATION_SPEC` | `tests/fixtures/stage-5-evaluation/stage-5-evaluation-spec.json` | 4750 | `62bf8ccf9fc18b2818c1d24d05426128092e5dd464760daed89986a947adbc1b` | 30534333283 | `913646777a64aa801c7dc263701802249164bf97` | evaluation spec `8248f250d85a78dca564dad07064748d261ed08465477156783c69ffc00a2cf3` |
| `STAGE_5_DATASET_MANIFEST` | `tests/fixtures/stage-5-dataset/stage-5-dataset-manifest.json` | 7254 | `c46a5b5a6c6ed831c8de3248b5826f27afd1f1b93154fa7d52d652bff68b4cd4` | 30538357437 | `8c87c86107bf32c7e9f2fd4d494a22d612dcf1b8` | dataset `3f9e3a1270b9479bd01767adcc5a6596132cb6c3734aa600e23ad25bc4abe760` |
| `STAGE_5_CANDIDATE_REGISTRY` | `tests/fixtures/stage-5-registry/stage-5-candidate-registry.json` | 17525 | `8364dd6bcb68b318d2550d726c286c24ff4cfbef53e7f698ca3b38db20d1fa7e` | 30541001265 | `2115bfa277d2ca2eb582a010e248f369096cb6fa` | registry `0fe0249174a2405d2966282ff7dd91c92c89d105fa04ee0c140072535ccb7d31` |
| `STAGE_5_RESEARCH_RESULTS` | `tests/fixtures/stage-5-research/stage-5-research-results.json` | 432980 | `9b0eda9677b63242632a8c3288e902007539fa113ea1362c4ec396e6dfc60186` | 30543669190 | `3cbf9b88e7929b5649b84094d77f1492919b2453` | results `621d253702921ec56bbfe0023bf0b1f86924a21b6c94a3578437f388d05bd6b7` |
| `STAGE_5_VALIDATION_DECISION` | `tests/fixtures/stage-5-research/stage-5-validation-decision.json` | 28035 | `edcacb3e73d9ab4788ebaabd84db64f9eb5a29cc839e2d010adf83f1206f6a34` | 30543669190 | `3cbf9b88e7929b5649b84094d77f1492919b2453` | decision `ab8d1acd8038c724245a8e7b4aff1639b632db8c486998b5ebd97848ae088699` |
| `STAGE_5_PROMOTION_DECISION` | `tests/fixtures/stage-5-research/stage-5-promotion-decision.json` | 8075 | `bb7413ff053e368b1499e76e084429a4504faaee4741e39e1606bad9ac930cf9` | 30543669190 | `3cbf9b88e7929b5649b84094d77f1492919b2453` | promotion receipt `44fddffd609f2dca6b009665ed5ec02bbfc4de8de4b5d21009a2460d6ba8c0f5` |

## Reproduction and original provenance

The Stage 5.1 subject was regenerated with the generator from `913646777a64aa801c7dc263701802249164bf97`, source commit fixed to that value, and the exact 755-byte entry-gate subject. The result was byte-identical: 4750 bytes, SHA-256 `62bf8ccf9fc18b2818c1d24d05426128092e5dd464760daed89986a947adbc1b`, evaluation spec ID `8248f250d85a78dca564dad07064748d261ed08465477156783c69ffc00a2cf3`.

The Stage 5 candidate registry was regenerated with the generator from `2115bfa277d2ca2eb582a010e248f369096cb6fa`, using the exact Stage 4A12 candidate manifest, the reproduced evaluation spec, and the exact dataset manifest. The result was byte-identical: 17525 bytes, SHA-256 `8364dd6bcb68b318d2550d726c286c24ff4cfbef53e7f698ca3b38db20d1fa7e`, registry ID `0fe0249174a2405d2966282ff7dd91c92c89d105fa04ee0c140072535ccb7d31`.

Run 30235971008's original attestation names `recomputed-candidate-manifest.json` with SHA-256 `3d110db1052b19ef76b4aabd571f2c610a5c68b2485d362a9dd50df61787e298`, workflow `.github/workflows/stage-4a12-candidate-proof.yml`, and producer commit `4b34e6a58e0b7bf93774bc8f3055fea60e28117d`. That digest exactly matches the committed canonical candidate manifest.

The Stage 4B closure JSON embeds historical source commit `c33d56d8e295dc064fa971cfa2128aaac41705da`. Its original run 30528115935 attestation separately binds the subject to PR merge commit `b2f11c0941b1e629e58c299169554de6051c902b`. These identities are intentionally not collapsed. Likewise, the Stage 4B4 proof embeds PR-head/source commit `9e0d9dafeead4ee22f38ae9e1f964cb15855da27`, while run 30525863496 attests the merge ref at `1a487bf18b0018e87e2df31acb93f74d25d1c901`.

## Stage 4B2 forensic recovery

The Stage 4B2 subject's original artifact from run 30320628525 expired. A bounded forensic reconstruction over `2026-07-28T01:35:00.000Z` through `2026-07-28T01:39:00.000Z` found one matching `generatedAt`, `2026-07-28T01:37:40.000Z`, among 241 candidates. T-1 second, T+1 second, and a one-byte mutation failed. The recovered bytes are the existing canonical fixture: 952 bytes, SHA-256 `5fefa5c1ddb025c94300e8b7dcb3b6d9dd5ba2e36a6d70e2ec10554d1d6a2453`, receipt ID `64b15a8acef9b1ba6f16ff87f81d27fcf28fbf6b94424d059521a20702165785`, source commit `81b0980f4fee168075a52c6ebcb12eb50f382217`. No second authority JSON is created.

## Unchanged safety state

This migration changes persistence and transport only. Historical raw hashes, subject IDs, source commits, generator semantics, fixtures, and proof authority are unchanged. The recorded safety state remains fail-closed: `PAPER_APPROVED=false`, `TESTNET_APPROVED=false`, `LIVE_APPROVED=false`, and `RUNTIME_STARTED=false`. No production, runtime, trading, backtest, Phase 9B, or Phase 9C code is changed.
