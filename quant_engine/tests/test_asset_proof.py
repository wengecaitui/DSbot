"""Stage 4A9 asset mapping, gap-policy, adapter and walk-forward tests."""

from __future__ import annotations

import unittest
import tempfile
from pathlib import Path

import pandas as pd

from quant_engine.proof.asset_manifest import _text_file_sha256, build_asset_manifest, verify_asset_manifest
from quant_engine.proof.gap_policy import GapPolicy, audit_ohlcv
from quant_engine.proof.strategy_adapter import Action, simulate_window
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

    def decide(self, history: pd.DataFrame, parameters):
        self.history_lengths.append(len(history))
        period = int(parameters.get("period", 5))
        return Action.ENTER_LONG if len(history) % period == 0 else (Action.EXIT if len(history) % period == 2 else Action.HOLD)


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


if __name__ == "__main__":
    unittest.main()
