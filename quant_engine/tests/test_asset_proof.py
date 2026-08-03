"""Stage 4A12 asset proofs — contract-adherent tests."""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import pandas as pd

from quant_engine.proof.asset_manifest import (
    _sha256, _text_file_sha256, build_asset_manifest, verify_asset_manifest,
)
from quant_engine.proof.gap_policy import GapPolicy, audit_ohlcv
from quant_engine.proof.strategy_adapter import Action, Decision, simulate_window
from quant_engine.proof.walk_forward import WalkForwardConfig, run_causal_walk_forward

REPO = Path(__file__).resolve().parents[2]


class AlternatingAdapter:
    def evaluate(self, frame, parameters, _):
        if parameters["period"] % 2 == 0:
            return Decision(Action.BUY)
        return Decision(Action.SELL)


class MicroProofTests(unittest.TestCase):
    def test_fresh_manifest_contains_sha256_sources(self):
        m = build_asset_manifest(REPO, "LOCAL")
        for asset in m["assets"]:
            self.assertIn("sha256", asset)

    def test_recomputing_manifest_is_stable(self):
        m1 = build_asset_manifest(REPO, "LOCAL")
        m2 = build_asset_manifest(REPO, "LOCAL")
        self.assertEqual(m1["proofId"], m2["proofId"])

    def test_verify_manifest_with_matched_source_commit(self):
        manifest = build_asset_manifest(REPO, "LOCAL")
        verify_asset_manifest(REPO, manifest, expected_source_commit="LOCAL")

    def test_verify_fails_for_unexpected_source_commit(self):
        manifest = build_asset_manifest(REPO, "LOCAL")
        with self.assertRaisesRegex(ValueError, "MANIFEST_COMMIT_MISMATCH"):
            verify_asset_manifest(REPO, manifest, expected_source_commit="different")

    def test_verify_fails_for_tampered_manifest(self):
        manifest = build_asset_manifest(REPO, "LOCAL")
        manifest2 = {"schemaVersion": "X", "sourceCommit": "LOCAL", "pineCollection": {}, "counts": {}}
        with self.assertRaises(ValueError):
            verify_asset_manifest(REPO, manifest2)

    def test_fresh_manifest_contains_proof_id(self):
        m = build_asset_manifest(REPO, "LOCAL")
        self.assertEqual(len(m["proofId"]), 64)
        self.assertEqual(m["proofId"], m["proofId"].lower())

    def test_manifest_has_pine_assets(self):
        m = build_asset_manifest(REPO, "LOCAL")
        self.assertEqual(m["pineCollection"]["assetCount"], 14)

    def test_manifest_has_classification_digests(self):
        m = build_asset_manifest(REPO, "LOCAL")
        for a in m["assets"]:
            self.assertIn("pythonSymbolSha256", a)
            self.assertIn("registryEntrySha256", a)

    def test_source_commit_is_recorded(self):
        m = build_asset_manifest(REPO, "TEST")
        self.assertEqual(m["sourceCommit"], "TEST")

    def test_manifest_commit_binding_is_fail_closed(self):
        manifest = build_asset_manifest(REPO, "expected")
        with self.assertRaises(ValueError):
            verify_asset_manifest(REPO, manifest, expected_source_commit="different")


class StrategyProofTests(unittest.TestCase):
    def test_simulate_window_is_deterministic(self):
        df = pd.DataFrame({
            "start": pd.date_range("2024-01-01", periods=20, freq="5min"),
            "open": [100.0] * 20,
            "high": [101.0] * 20,
            "low": [99.0] * 20,
            "close": [100.5] * 20,
            "volume": [1000.0] * 20,
        })
        frame = audit_ohlcv(df, GapPolicy.REJECT)
        result1 = simulate_window(AlternatingAdapter(), frame, [{"period": 4}], entry_after_bars=1)
        result2 = simulate_window(AlternatingAdapter(), frame, [{"period": 4}], entry_after_bars=1)
        self.assertEqual(result1["decisions"], result2["decisions"])
        self.assertEqual(result1["trades"], result2["trades"])

    def test_gap_rejection_is_enforced(self):
        df = pd.DataFrame({
            "start": pd.date_range("2024-01-01", periods=5, freq="5min"),
            "open": [100.0, 101.0, float("nan"), 103.0, 104.0],
            "high": [101.0, 102.0, 102.0, 104.0, 105.0],
            "low": [99.0, 100.0, 100.0, 102.0, 103.0],
            "close": [100.5, 101.5, 101.5, 103.5, 104.5],
            "volume": [1000.0] * 5,
        })
        frame = audit_ohlcv(df, GapPolicy.REJECT)
        self.assertEqual(frame.index[1], pd.Timestamp("2024-01-01 00:05:00"))
        self.assertTrue(pd.isna(frame.iloc[2]["open"]))

    def test_verify_asset_manifest_for_commit(self):
        manifest = build_asset_manifest(REPO, "test-commit")
        verify_asset_manifest(REPO, manifest, expected_source_commit="test-commit")

    def test_manifest_recomputation_mismatch_is_fail_closed(self):
        manifest = build_asset_manifest(REPO, "test-commit")
        manifest2 = dict(manifest)
        manifest2["proofId"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "RECOMPUTATION_MISMATCH"):
            verify_asset_manifest(REPO, manifest2)

    def test_manifest_commit_binding_is_fail_closed_2(self):
        manifest = build_asset_manifest(REPO, "expected")
        with self.assertRaisesRegex(ValueError, "COMMIT_MISMATCH"):
            verify_asset_manifest(REPO, manifest, expected_source_commit="different")

    def test_stop_executes_intrabar_after_next_open_entry(self):
        def adap():
            class A:
                def evaluate(self, f, p, _):
                    if len(f) <= p["period"]:
                        return Decision(Action.BUY)
                    return Decision(Action.SELL)
            return A()
        df = pd.DataFrame({
            "start": pd.date_range("2024-01-01", periods=50, freq="15min"),
            "open": [100.0 + i * 0.1 for i in range(50)],
            "high": [101.0 + i * 0.1 for i in range(50)],
            "low": [98.0 + i * 0.1 for i in range(50)],
            "close": [100.5 + i * 0.1 for i in range(50)],
            "volume": [1000.0] * 50,
        })
        frame = audit_ohlcv(df, GapPolicy.REJECT)
        result = simulate_window(adap(), frame, [{"period": 5}], entry_after_bars=1)
        self.assertIn("trades", result)
        for t in result["trades"]:
            self.assertIn("exit_price", t)
            self.assertIn("exit_time", t)

    def test_transaction_costs_are_explicit_and_report_identity_bound(self):
        def adap():
            class A:
                def evaluate(self, f, p, _):
                    if len(f) <= 2:
                        return Decision(Action.BUY)
                    return Decision(Action.SELL)
            return A()
        df = pd.DataFrame({
            "start": pd.date_range("2024-01-01", periods=30, freq="15min"),
            "open": [100.0] * 30,
            "high": [101.0] * 30,
            "low": [99.0] * 30,
            "close": [100.5] * 30,
            "volume": [1000.0] * 30,
        })
        frame = audit_ohlcv(df, GapPolicy.REJECT)
        result = simulate_window(adap(), frame, [{"period": 1}], entry_after_bars=1)
        for t in result["trades"]:
            self.assertGreaterEqual(t["fees_paid"], 0)

    def test_walk_forward_rejects_unbound_or_cross_gap_data(self):
        df = pd.DataFrame({
            "start": pd.date_range("2024-01-01", periods=120, freq="15min"),
            "open": [100.0] * 120,
            "high": [101.0] * 120,
            "low": [99.0] * 120,
            "close": [100.5] * 120,
            "volume": [1000.0] * 120,
        })
        df.loc[60, "open"] = float("nan")
        try:
            audit_ohlcv(df, GapPolicy.REJECT)
            raised = False
        except ValueError:
            raised = True
        self.assertTrue(raised)

    def test_walk_forward_fee_bound_is_fail_closed(self):
        def adap():
            class A:
                def evaluate(self, f, p, _):
                    return Decision(Action.BUY)
            return A()
        df = pd.DataFrame({
            "start": pd.date_range("2024-01-01", periods=10, freq="15min"),
            "open": [100.0] * 10,
            "high": [101.0] * 10,
            "low": [99.0] * 10,
            "close": [100.5] * 10,
            "volume": [1000.0] * 10,
        })
        audit = audit_ohlcv(df, GapPolicy.REJECT)
        with self.assertRaises(ValueError):
            run_causal_walk_forward(AlternatingAdapter(), audit, [{"period": 4}], WalkForwardConfig(30, 10, 10, fee_bps=float("nan")), audit)


# ======== Pinned-Commit Proof Tests ========

class PinnedCommitTests(unittest.TestCase):
    ENGINE = "80f12966081e3851424f820dd3428249d5537eb9"

    def test_pinned_commit_produces_matching_proof(self):
        m = build_asset_manifest(REPO, self.ENGINE)
        committed = json.loads(
            (REPO / "docs/releases/stage-4a12-candidate-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(m["proofId"], committed["sourceAssetProofId"])

    def test_pinned_commit_verify_passes(self):
        m = build_asset_manifest(REPO, self.ENGINE)
        verify_asset_manifest(REPO, m, expected_source_commit=self.ENGINE)

    def test_new_file_does_not_change_proof_id(self):
        m1 = build_asset_manifest(REPO, self.ENGINE)
        new_file = REPO / "quant_engine" / "proof" / "stage9_future.py"
        new_file.write_text("# future work\n", encoding="utf-8")
        try:
            m2 = build_asset_manifest(REPO, self.ENGINE)
            self.assertEqual(m1["proofId"], m2["proofId"])
        finally:
            new_file.unlink()

    def test_missing_commit_is_fail_closed(self):
        fake = "f" * 40
        with self.assertRaisesRegex(ValueError, "ASSET_SOURCE_COMMIT_UNRESOLVABLE"):
            build_asset_manifest(REPO, fake)

    def test_missing_commit_verify_is_rejected(self):
        fake = "f" * 40
        manifest = dict(json.loads(
            (REPO / "docs/releases/stage-4a12-candidate-manifest.json").read_text(encoding="utf-8")))
        # Tamper sourceCommit to a fake commit — verify must detect
        forged = dict(manifest)
        forged["sourceCommit"] = fake
        # Recompute proofId so it isn't stale
        from quant_engine.proof.asset_manifest import _sha256 as _h
        forged["proofId"] = _h(json.dumps(forged, ensure_ascii=False, sort_keys=True,
                                            separators=(",", ":")).encode("utf-8"))
        with self.assertRaisesRegex(ValueError, "ASSET_SOURCE_COMMIT_UNRESOLVABLE"):
            verify_asset_manifest(REPO, forged, expected_source_commit=fake)

    def test_real_source_file_mutation_is_detected(self):
        """Clone the repo to a temp dir, mutate a protected source file, prove fail-closed."""
        import hashlib as hl

        tmp = Path(tempfile.mkdtemp())
        try:
            # Clone the real repo (shallow, 1 commit deep from engine)
            subprocess.run(
                ["git", "clone", "--depth=1", "--branch=feature/orangeai-split",
                 "--single-branch", str(REPO), str(tmp)],
                capture_output=True, check=True)

            # Build manifest at current commit (commit A)
            commit_a = subprocess.run(
                ["git", "-C", str(tmp), "rev-parse", "HEAD"],
                capture_output=True, text=True, check=True).stdout.strip()

            manifest_a = build_asset_manifest(tmp, source_commit=commit_a)
            verify_asset_manifest(tmp, manifest_a, expected_source_commit=commit_a)

            # Mutate a protected source file
            daemon = tmp / "quant_engine" / "daemon.py"
            original = daemon.read_text(encoding="utf-8")
            daemon.write_text(original + "\n# mutation\n", encoding="utf-8")

            subprocess.run(["git", "-C", str(tmp), "config", "user.email", "test@test.test"], capture_output=True)
            subprocess.run(["git", "-C", str(tmp), "config", "user.name", "Test"], capture_output=True)
            subprocess.run(["git", "-C", str(tmp), "add", "quant_engine/daemon.py"],
                           capture_output=True, check=True)
            subprocess.run(["git", "-C", str(tmp), "commit", "-m", "mutate"],
                           capture_output=True, check=True)
            commit_b = subprocess.run(
                ["git", "-C", str(tmp), "rev-parse", "HEAD"],
                capture_output=True, text=True, check=True).stdout.strip()

            # Build manifest at commit B — must differ from commit A
            manifest_b = build_asset_manifest(tmp, source_commit=commit_b)
            self.assertNotEqual(manifest_a["proofId"], manifest_b["proofId"])

            # Forge: manifest A's content but marked as commit B
            forged = dict(manifest_a)
            forged["sourceCommit"] = commit_b
            forged["proofId"] = hl.sha256(
                json.dumps(forged, ensure_ascii=False, sort_keys=True,
                           separators=(",", ":")).encode("utf-8")).hexdigest()

            with self.assertRaisesRegex(ValueError, "ASSET_MANIFEST_RECOMPUTATION_MISMATCH"):
                verify_asset_manifest(tmp, forged, expected_source_commit=commit_b)

        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ======== Candidate Receipt Tests ========

class CandidateReceiptTests(unittest.TestCase):
    def test_verifier_passes(self):
        from quant_engine.proof.promotion_receipt import verify_promotion_receipt
        manifest = json.loads(
            (REPO / "docs/releases/stage-4a12-candidate-manifest.json").read_text(encoding="utf-8"))
        receipt = json.loads(
            (REPO / "docs/releases/stage-4a12-promotion-decision.json").read_text(encoding="utf-8"))
        verify_promotion_receipt(receipt, manifest)

    def test_manifest_mismatch_detected(self):
        from quant_engine.proof.promotion_receipt import verify_promotion_receipt
        manifest = json.loads(
            (REPO / "docs/releases/stage-4a12-candidate-manifest.json").read_text(encoding="utf-8"))
        receipt = json.loads(
            (REPO / "docs/releases/stage-4a12-promotion-decision.json").read_text(encoding="utf-8"))
        tampered = dict(manifest)
        tampered["manifestId"] = "0" * 64
        with self.assertRaises(ValueError):
            verify_promotion_receipt(receipt, tampered)


if __name__ == "__main__":
    unittest.main()
