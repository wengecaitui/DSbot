# Stage 5.3-5.4 — Candidate Registry and Offline Evaluation Harness

This change registers exactly the four Stage 4A12 derived StrategySpecs and their three predeclared parameter sets. It does not invent candidates, expand the frozen research budget, or access the locked test. The no-trade and lexically selected existing-spec baselines are non-rankable and consume no candidate budget.

The offline harness evaluates completed-bar decisions at the next open. It models fees, half-spread, slippage, adverse periodic funding, stop-first ambiguity, turnover, exposure, and a deliberately limited capacity proxy. Each result contains trade records, an equity curve, a drawdown series, all twenty frozen metrics, deterministic intent identities, component digests, and a self-identity.

All generated records are labelled `OFFLINE_EVALUATION_RECORD`, `NOT_A_PAPER_FILL`, `NOT_AN_EXCHANGE_FILL`, and `NOT_A_REAL_ORDER`. The implementation imports no Paper, Testnet, Live, broker, or exchange adapter and authorizes no runtime.

CI downloads the authoritative Stage 4A12 candidate artifact and Stage 5.1 evaluation constitution, exact-hashes them with the Stage 5.2 dataset receipt, generates the bounded registry for the exact source commit, independently recomputes it, uploads the raw bytes, and produces an OIDC-backed attestation.

The registry also makes a pre-existing transport distinction explicit: Stage 5.1 recorded SHA-256 `919146d3...` for a Windows CRLF checkout, while the authoritative Stage 4A12 workflow artifact uses LF bytes with SHA-256 `3d110db1...`. The verifier exact-hashes only these two known encodings, canonicalizes to the attested LF artifact bytes, records both digests, and rejects every other byte stream. No candidate semantics or frozen research rule changes.
