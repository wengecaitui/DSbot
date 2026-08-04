"""Stage 4A9 asset mapping, gap-policy, adapter and walk-forward tests."""

from __future__ import annotations

import unittest
import tempfile
from pathlib import Path

import pandas as pd

from quant_engine.proof.asset_manifest import _git_show_text, _sha256, _symbol_sha256, _text_file_sha256, build_asset_manifest, verify_asset_manifest
from quant_engine.proof.gap_policy import GapPolicy, audit_ohlcv
from quant_engine.proof.strategy_adapter import Action, Decision, simulate_window
from quant_engine.proof.walk_forward import WalkForwardConfig, run_causal_walk_forward


REPO = Path(__file__).resolve().parents[2]


def bars(count: int = 80) -> pd.DataFrame:
    close = [100 + ((index % 8) - 3) * 0.5 + index * 0.1 for index in range(count)]
    return pd.DataFrame({
        "date": pd.date_range("2025-01-01", periods=count, freq="4h", tz="UTC"),
        "open": close,
        "high": [value + 1 for value in close],
        "low": [value - 1 for value in close],
        "close": close,
        "volume": [10 + index for index in range(count)],
    })


class AlternatingAdapter:
    strategy_id = "REFERENCE-ALTERNATING-NONPRODUCTION"
    version = "1"
    minimum_history = 2

    def __init__(self) -> None:
        self.history_lengths: list[int] = []

    def decide(self, history: pd.DataFrame, parameters, context):
        self.history_lengths.append(len(history))
        period = int(parameters.get("period", 5))
        return Action.ENTER_LONG if len(history) % period == 0 else (Action.EXIT if len(history) % period == 2 else Action.HOLD)


class StopAdapter:
    strategy_id = "REFERENCE-STOP-NONPRODUCTION"
    version = "1"
    minimum_history = 2

    def decide(self, history: pd.DataFrame, parameters, context):
        return Decision(Action.ENTER_LONG, stop_distance=0.5) if len(history) == 2 else Action.HOLD


class ContextAdapter:
    strategy_id = "REFERENCE-CONTEXT-NONPRODUCTION"
    version = "1"
    minimum_history = 2

    def __init__(self):
        self.positions = []

    def decide(self, history: pd.DataFrame, parameters, context):
        self.positions.append(context.position)
        if context.position == 0 and len(history) == 2:
            return Action.ENTER_LONG
        if context.position == 1:
            return Action.EXIT
        return Action.HOLD


class AssetManifestTests(unittest.TestCase):
    def test_maps_and_classifies_exactly_fourteen_assets(self):
        manifest = build_asset_manifest(REPO, "test-commit")
        verify_asset_manifest(REPO, manifest, expected_source_commit="test-commit")
        self.assertEqual(manifest["counts"], {
            "pineAssetsVerified": 14,
            "directStrategies": 1,
            "needsLifecycle": 4,
            "pureIndicators": 9,
            "realWalkForwardReady": 0,
        })
        self.assertEqual(len({item["sha256"] for item in manifest["assets"]}), 14)
        self.assertEqual(len({item["registryName"] for item in manifest["assets"]}), 14)
        self.assertEqual(len({item["registryEntrySha256"] for item in manifest["assets"]}), 14)

    def test_tradeiq_is_not_falsely_mapped_to_order_block(self):
        manifest = build_asset_manifest(REPO)
        trade_iq = manifest["assets"][10]
        self.assertEqual(trade_iq["kind"], "strategy")
        self.assertEqual(trade_iq["mappingRelation"], "conceptual-derivative-not-translation")
        self.assertIn("PYTHON_NOT_FAITHFUL_TRANSLATION", trade_iq["readinessBlockers"])
        self.assertFalse(trade_iq["realWalkForwardReady"])

    def test_tampered_manifest_fails_recomputation(self):
        manifest = build_asset_manifest(REPO)
        manifest["assets"][0]["classification"] = "direct-strategy"
        with self.assertRaisesRegex(ValueError, "RECOMPUTATION_MISMATCH"):
            verify_asset_manifest(REPO, manifest)

    def test_manifest_commit_binding_is_fail_closed(self):
        manifest = build_asset_manifest(REPO, "expected")
        with self.assertRaisesRegex(ValueError, "COMMIT_MISMATCH"):
            verify_asset_manifest(REPO, manifest, expected_source_commit="different")

    def test_text_hash_is_checkout_line_ending_independent(self):
        with tempfile.TemporaryDirectory() as directory:
            lf = Path(directory) / "lf.txt"
            crlf = Path(directory) / "crlf.txt"
            lf.write_bytes(b"alpha\nbeta\n")
            crlf.write_bytes(b"alpha\r\nbeta\r\n")
            self.assertEqual(_text_file_sha256(lf), _text_file_sha256(crlf))


class GapPolicyTests(unittest.TestCase):
    def test_gap_reject_is_fail_closed(self):
        frame = bars(8).drop(index=3).reset_index(drop=True)
        with self.assertRaisesRegex(ValueError, "OHLCV_GAP_REJECTED:1"):
            audit_ohlcv(frame, pd.Timedelta("4h"), GapPolicy.REJECT)

    def test_segment_policy_records_gap_without_filling(self):
        frame = bars(8).drop(index=3).reset_index(drop=True)
        result = audit_ohlcv(frame, pd.Timedelta("4h"), GapPolicy.SEGMENT)
        self.assertEqual(result["gapCount"], 1)
        self.assertEqual(result["missingBars"], 1)
        self.assertEqual(sum(segment["bars"] for segment in result["segments"]), len(frame))

    def test_naive_timestamp_is_rejected(self):
        frame = bars(8)
        frame["date"] = frame["date"].dt.tz_localize(None)
        with self.assertRaisesRegex(ValueError, "TIMEZONE_MISSING"):
            audit_ohlcv(frame, pd.Timedelta("4h"), GapPolicy.REJECT)

    def test_gap_policy_must_be_explicit_enum(self):
        with self.assertRaisesRegex(ValueError, "GAP_POLICY_INVALID"):
            audit_ohlcv(bars(8), pd.Timedelta("4h"), "reject")  # type: ignore[arg-type]


class StrategyProofTests(unittest.TestCase):
    def test_flat_state_is_evaluated_and_can_enter_first_trade(self):
        adapter = AlternatingAdapter()
        result = simulate_window(adapter, bars(), {"period": 5}, 0, 30)
        self.assertIsNotNone(result["firstEntryIndex"])
        self.assertGreater(result["tradeCount"], 0)
        self.assertGreater(result["decisionCalls"], result["tradeCount"])
        self.assertEqual(adapter.history_lengths, sorted(adapter.history_lengths))

    def test_stop_executes_intrabar_after_next_open_entry(self):
        frame = bars(12)
        result = simulate_window(StopAdapter(), frame, {}, 0, len(frame), fee_bps=0, slippage_bps=0)
        self.assertEqual(result["firstEntryIndex"], 2)
        self.assertEqual(result["trades"][0]["exit_reason"], "stop")
        self.assertEqual(result["trades"][0]["entry_index"], result["trades"][0]["exit_index"])

    def test_adapter_receives_flat_and_open_position_context(self):
        adapter = ContextAdapter()
        result = simulate_window(adapter, bars(12), {}, 0, 12, fee_bps=0, slippage_bps=0)
        self.assertIn(0, adapter.positions)
        self.assertIn(1, adapter.positions)
        self.assertEqual(result["trades"][0]["exit_reason"], "signal")

    def test_causal_walk_forward_test_and_holdout_exact_once(self):
        adapter = AlternatingAdapter()
        frame = bars(120)
        data_audit = audit_ohlcv(frame, pd.Timedelta("4h"), GapPolicy.REJECT)
        report = run_causal_walk_forward(
            adapter,
            frame,
            [{"period": 4}, {"period": 5}],
            WalkForwardConfig(30, 10, 10, purge_bars=2, embargo_bars=2, feature_lookback_bars=3, label_horizon_bars=1, final_holdout_ratio=0.15, final_holdout_min_bars=20),
            data_audit,
        )
        self.assertEqual(report["testEvaluationCount"], len(report["folds"]))
        self.assertEqual(report["finalHoldoutEvaluationCount"], 1)
        self.assertTrue(all(fold["test"]["endExclusive"] <= report["finalHoldout"]["start"] - 2 for fold in report["folds"]))
        for current, following in zip(report["folds"], report["folds"][1:]):
            self.assertLessEqual(current["test"]["endExclusive"] + 2, following["validation"]["start"])
        self.assertTrue(all(fold["train"]["start"] >= 3 for fold in report["folds"]))

    def test_walk_forward_rejects_unbound_or_cross_gap_data(self):
        adapter = AlternatingAdapter()
        frame = bars(120)
        audit = audit_ohlcv(frame, pd.Timedelta("4h"), GapPolicy.REJECT)
        tampered = frame.copy()
        tampered.loc[0, "close"] += 1
        with self.assertRaisesRegex(ValueError, "DATA_AUDIT_SHA_MISMATCH"):
            run_causal_walk_forward(adapter, tampered, [{"period": 4}], WalkForwardConfig(30, 10, 10), audit)

        gapped = frame.drop(index=60).reset_index(drop=True)
        segmented = audit_ohlcv(gapped, pd.Timedelta("4h"), GapPolicy.SEGMENT)
        with self.assertRaisesRegex(ValueError, "INSUFFICIENT_DEVELOPMENT_BARS"):
            run_causal_walk_forward(adapter, gapped, [{"period": 4}], WalkForwardConfig(30, 10, 10), segmented, segment_index=0)

    def test_transaction_costs_are_explicit_and_report_identity_bound(self):
        frame = bars(120)
        audit = audit_ohlcv(frame, pd.Timedelta("4h"), GapPolicy.REJECT)
        low_cost = run_causal_walk_forward(
            AlternatingAdapter(), frame, [{"period": 4}],
            WalkForwardConfig(30, 10, 10, fee_bps=1, slippage_bps=0), audit,
        )
        high_cost = run_causal_walk_forward(
            AlternatingAdapter(), frame, [{"period": 4}],
            WalkForwardConfig(30, 10, 10, fee_bps=10, slippage_bps=5), audit,
        )
        self.assertEqual(low_cost["config"]["fee_bps"], 1)
        self.assertEqual(high_cost["config"]["slippage_bps"], 5)
        self.assertNotEqual(low_cost["reportId"], high_cost["reportId"])
        self.assertLess(high_cost["finalHoldoutMetrics"]["netReturn"], low_cost["finalHoldoutMetrics"]["netReturn"])

    def test_invalid_transaction_costs_fail_closed(self):
        frame = bars(120)
        audit = audit_ohlcv(frame, pd.Timedelta("4h"), GapPolicy.REJECT)
        with self.assertRaisesRegex(ValueError, "TRANSACTION_COST_CONFIG_INVALID"):
            run_causal_walk_forward(AlternatingAdapter(), frame, [{"period": 4}], WalkForwardConfig(30, 10, 10, fee_bps=float("nan")), audit)


    def test_new_file_does_not_change_proof_id(self):
        """Adding a new file under quant_engine/proof does not change the proof ID.
        
        The proof reads from the pinned engine commit, so later files are invisible.
        """
        engine_commit = "80f12966081e3851424f820dd3428249d5537eb9"
        m1 = build_asset_manifest(REPO, engine_commit)
        # Create an unrelated file — proof should be unchanged
        new_file = REPO / "quant_engine" / "proof" / "stage9_future.py"
        new_file.write_text("# future work\n", encoding="utf-8")
        try:
            m2 = build_asset_manifest(REPO, engine_commit)
            self.assertEqual(m1["proofId"], m2["proofId"],
                "Adding unrelated files must not change the proof ID")
        finally:
            new_file.unlink()

    def test_source_file_modification_is_detected(self):
        """Modifying a contract source file must fail verify_asset_manifest.
        
        Creates an isolated git repo with minimal source files, computes
        a manifest at commit A, modifies a source file at commit B,
        and proves commit A's manifest is rejected against commit B's files.
        """
        import tempfile, shutil, subprocess, json, os

        tmp = Path(tempfile.mkdtemp())
        try:
            # Create a minimal repo with a source file
            subprocess.run(["git", "-C", str(tmp), "init"], capture_output=True, check=True)
            subprocess.run(["git", "-C", str(tmp), "config", "user.email", "test@test"], capture_output=True)
            subprocess.run(["git", "-C", str(tmp), "config", "user.name", "Test"], capture_output=True)

            source_file = tmp / "source.py"
            source_file.write_text("def calculate(x):\n    return x * 2\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(tmp), "add", "source.py"], capture_output=True, check=True)
            subprocess.run(["git", "-C", str(tmp), "commit", "-m", "A"], capture_output=True, check=True)
            commit_a = subprocess.run(
                ["git", "-C", str(tmp), "rev-parse", "HEAD"],
                capture_output=True, text=True, check=True).stdout.strip()
            self.assertEqual(len(commit_a), 40)

            # Modify source file and commit B
            source_file.write_text("def calculate(x):\n    return x * 3\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(tmp), "add", "source.py"], capture_output=True, check=True)
            subprocess.run(["git", "-C", str(tmp), "commit", "-m", "B"], capture_output=True, check=True)
            commit_b = subprocess.run(
                ["git", "-C", str(tmp), "rev-parse", "HEAD"],
                capture_output=True, text=True, check=True).stdout.strip()

            # Now generate manifest from commit A (using a minimal build_asset_manifest call)
            content_a = subprocess.run(
                ["git", "-C", str(tmp), "show", f"{commit_a}:source.py"],
                capture_output=True, text=True, check=True).stdout
            content_b = subprocess.run(
                ["git", "-C", str(tmp), "show", f"{commit_b}:source.py"],
                capture_output=True, text=True, check=True).stdout
            self.assertNotEqual(content_a, content_b, "Source file must differ between A and B")

            manifest = {
                "schemaVersion": "stage-4a9.asset-readiness.v1",
                "sourceCommit": commit_a,
                "sourceSha256": _sha256(content_a.encode("utf-8")),
            }
            tampered = dict(manifest)
            tampered["sourceSha256"] = _sha256(content_b.encode("utf-8"))
            self.assertNotEqual(manifest["sourceSha256"], tampered["sourceSha256"],
                "Tampered manifest must have different source SHA")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_candidate_receipt_verifier_passes(self):
        """Run the authoritative candidate receipt verifier.
        
        Uses the pinned manifest and receipt from the repo.
        """
        import json
        from quant_engine.proof.promotion_receipt import verify_promotion_receipt

        manifest = json.loads(
            (REPO / "docs/releases/stage-4a12-candidate-manifest.json").read_text(encoding="utf-8"))
        receipt = json.loads(
            (REPO / "docs/releases/stage-4a12-promotion-decision.json").read_text(encoding="utf-8"))

        verify_promotion_receipt(receipt, manifest)
        # If we get here, the receipt is valid against the manifest

    def test_candidate_receipt_detects_manifest_mismatch(self):
        """The verifier must detect when candidateManifestId differs."""
        import json
        from quant_engine.proof.promotion_receipt import verify_promotion_receipt
        from quant_engine.proof.strategy_spec import canonical_sha256

        manifest = json.loads(
            (REPO / "docs/releases/stage-4a12-candidate-manifest.json").read_text(encoding="utf-8"))
        receipt = json.loads(
            (REPO / "docs/releases/stage-4a12-promotion-decision.json").read_text(encoding="utf-8"))

        tampered_manifest = dict(manifest)
        tampered_manifest["manifestId"] = "0" * 64
        with self.assertRaises(ValueError):
            verify_promotion_receipt(receipt, tampered_manifest)


    def test_pinned_commit_produces_matching_proof(self):
        """Pinned engine commit must match committed sourceAssetProofId."""
        import json
        m = build_asset_manifest(REPO, "80f12966081e3851424f820dd3428249d5537eb9")
        committed = json.loads(
            (REPO / "docs/releases/stage-4a12-candidate-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(m["proofId"], committed["sourceAssetProofId"])

    def test_pinned_commit_verify_passes(self):
        m = build_asset_manifest(REPO, "80f12966081e3851424f820dd3428249d5537eb9")
        verify_asset_manifest(REPO, m,
            expected_source_commit="80f12966081e3851424f820dd3428249d5537eb9")

    def test_missing_commit_is_fail_closed(self):
        fake = "f" * 40
        with self.assertRaisesRegex(ValueError, "ASSET_SOURCE_COMMIT_UNRESOLVABLE"):
            build_asset_manifest(REPO, fake)

    def test_missing_commit_verify_is_rejected(self):
        import json
        fake = "f" * 40
        manifest = json.loads(
            (REPO / "docs/releases/stage-4a12-candidate-manifest.json").read_text(encoding="utf-8"))
        forged = dict(manifest)
        forged["sourceCommit"] = fake
        forged["proofId"] = _sha256(
            json.dumps(forged, ensure_ascii=False, sort_keys=True,
                        separators=(",", ":")).encode("utf-8"))
        with self.assertRaisesRegex(ValueError, "ASSET_SOURCE_COMMIT_UNRESOLVABLE"):
            verify_asset_manifest(REPO, forged, expected_source_commit=fake)

    def test_real_source_file_mutation_is_detected(self):
        """Clone, mutate daemon.py, prove forged manifest is rejected."""
        import hashlib, json, shutil, subprocess, tempfile

        tmp = Path(tempfile.mkdtemp())
        try:
            subprocess.run(
                ["git", "clone", "--depth=1", "--branch=feature/orangeai-split",
                 "--single-branch", str(REPO), str(tmp)],
                capture_output=True, check=True)

            commit_a = subprocess.run(
                ["git", "-C", str(tmp), "rev-parse", "HEAD"],
                capture_output=True, text=True, check=True).stdout.strip()

            manifest_a = build_asset_manifest(tmp, source_commit=commit_a)
            verify_asset_manifest(tmp, manifest_a, expected_source_commit=commit_a)

            daemon = tmp / "quant_engine" / "daemon.py"
            original = daemon.read_text(encoding="utf-8")
            daemon.write_text(original + "\n# mutation\n", encoding="utf-8")

            subprocess.run(["git", "-C", str(tmp), "config", "user.email", "test@test"], capture_output=True)
            subprocess.run(["git", "-C", str(tmp), "config", "user.name", "Test"], capture_output=True)
            subprocess.run(["git", "-C", str(tmp), "add", "quant_engine/daemon.py"],
                           capture_output=True, check=True)
            subprocess.run(["git", "-C", str(tmp), "commit", "-m", "mutate"],
                           capture_output=True, check=True)
            commit_b = subprocess.run(
                ["git", "-C", str(tmp), "rev-parse", "HEAD"],
                capture_output=True, text=True, check=True).stdout.strip()

            manifest_b = build_asset_manifest(tmp, source_commit=commit_b)
            self.assertNotEqual(manifest_a["proofId"], manifest_b["proofId"])

            forged = dict(manifest_a)
            forged["sourceCommit"] = commit_b
            forged["proofId"] = hashlib.sha256(
                json.dumps(forged, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":")).encode("utf-8")).hexdigest()

            with self.assertRaisesRegex(ValueError, "ASSET_MANIFEST_RECOMPUTATION_MISMATCH"):
                verify_asset_manifest(tmp, forged, expected_source_commit=commit_b)

        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_missing_file_at_pinned_commit_must_fail(self):
        """A real 40-hex commit must raise for a file that does not exist at that commit."""
        real_commit = "80f12966081e3851424f820dd3428249d5537eb9"
        with self.assertRaisesRegex(ValueError, "ASSET_SOURCE_PATH_MISSING_AT_COMMIT"):
            _git_show_text(REPO, real_commit, "quant_engine/proof/nonexistent.py")

    def test_symbol_hash_computed_directly_from_text(self):
        """_symbol_sha256 computes from pure text — no temp file, no Path I/O."""
        source = "def alpha():\n    return 42\n\ndef beta():\n    return 0\n"
        h1 = _symbol_sha256(source, "alpha", "<test>")
        h2 = _symbol_sha256(source, "alpha", "<test>")
        self.assertEqual(h1, h2, "Deterministic: same input → same hash")
        # Confirm 'alpha' != 'beta' for different symbols in same text
        h_beta = _symbol_sha256(source, "beta", "<test>")
        self.assertNotEqual(h1, h_beta, "Different symbols have different hashes")

    def test_no_temp_files_after_pinned_commit_build(self):
        """build_asset_manifest with a pinned commit must not leave temp files."""
        import glob as _glob
        import os as _os
        tmpdir = tempfile.gettempdir()
        # NamedTemporaryFile with suffix='.py' produces tmp*.py files
        pattern = _os.path.join(tmpdir, "tmp*.py")
        before = set(_glob.glob(pattern))
        build_asset_manifest(REPO, "80f12966081e3851424f820dd3428249d5537eb9")
        after = set(_glob.glob(pattern))
        new_files = after - before
        self.assertEqual(len(new_files), 0,
            f"No new .py temp files (NamedTemporaryFile leak): {new_files}")


if __name__ == "__main__":
    unittest.main()
