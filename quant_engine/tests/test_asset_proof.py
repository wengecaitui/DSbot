"""Stage 4A9 asset mapping, gap-policy, adapter and walk-forward tests."""

from __future__ import annotations

import unittest
import tempfile
from pathlib import Path

import pandas as pd

from quant_engine.proof.asset_manifest import _text_file_sha256, build_asset_manifest, verify_asset_manifest
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

    def test_source_file_change_is_detected(self):
        """Modifying a file in the proof contract must fail verification.
        
        The verify_asset_manifest checks the pinned commit content, so if
        the manifest doesn't match the commit's source files, it rejects.
        """
        engine_commit = "80f12966081e3851424f820dd3428249d5537eb9"
        manifest = build_asset_manifest(REPO, engine_commit)
        # Tamper the manifest's daemonSha256 to simulate source change
        tampered = dict(manifest)
        tampered["registry"] = dict(tampered["registry"])
        tampered["registry"]["daemonSha256"] = "0" * 64
        with self.assertRaises(ValueError):
            verify_asset_manifest(REPO, tampered,
                                  expected_source_commit=engine_commit)


if __name__ == "__main__":
    unittest.main()
