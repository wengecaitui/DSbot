"""
Regime Gate — Python focused tests + golden-vector parity
SUSA-Inspired, project-specific deterministic heuristic (arXiv 2607.22491).
"""

import json
import math
import os
import unittest

# Ensure quant_engine is importable
import sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from quant_engine.indicators.regime_gate import (
    calculate,
    classify,
    entry_policy,
    SCHEMA_VERSION,
    POLICY_VERSION,
    WINDOW,
    _validate_observation,
)


GOLDEN_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "..",
    "tests",
    "fixtures",
    "regime-gate-golden-vectors.json",
)
SNAPSHOT_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "..",
    "tests",
    "fixtures",
    "regime-gate-snapshot-parity.json",
)


class TestRegimeGateGoldenVectors(unittest.TestCase):
    """Python must produce the same result as TypeScript on the same input."""

    @classmethod
    def setUpClass(cls):
        if not os.path.exists(GOLDEN_PATH):
            raise unittest.SkipTest(f"Golden vectors not found: {GOLDEN_PATH}")
        with open(GOLDEN_PATH) as f:
            cls.vectors = json.load(f)
        with open(SNAPSHOT_PATH) as f:
            cls.expected_snapshots = json.load(f)

    def test_golden_vectors(self):
        failures = []
        for vec in self.vectors:
            with self.subTest(id=vec["id"]):
                obs = vec["obs"]
                snapshot = classify(obs["prices"], obs["closeTimesMs"], obs["decisionTimeMs"])
                self.assertEqual(
                    snapshot["regime"],
                    vec["expectedRegime"],
                    f'{vec["id"]}: expected {vec["expectedRegime"]}, got {snapshot["regime"]} (reason={snapshot["reasonCode"]})',
                )
                self.assertEqual(snapshot["valid"], vec["expectedValid"])
                self.assertEqual(snapshot, self.expected_snapshots[vec["id"]])
                decision = entry_policy(snapshot)
                self.assertEqual(
                    decision["allow"],
                    vec["expectedAllow"],
                    f'{vec["id"]}: expected allow={vec["expectedAllow"]}',
                )

    def test_all_golden_vectors_covered(self):
        expected_ids = {"calm", "onset", "recovery", "persistent_stress",
                        "UNKNOWN_insufficient_data", "UNKNOWN_non_finite",
                        "threshold_exact_boundary", "timestamp_gap"}
        actual_ids = {v["id"] for v in self.vectors}
        missing = expected_ids - actual_ids
        self.assertSetEqual(missing, set(), f"Missing golden vectors: {missing}")


class TestRegimeGatePython(unittest.TestCase):

    def test_dataframe_without_timestamp_fails_closed(self):
        import pandas as pd

        snapshot = calculate(pd.DataFrame({"close": [100.0] * 30}), {})
        self.assertFalse(snapshot["valid"])
        self.assertEqual(snapshot["reasonCode"], "invalid_config")

    def test_unsupported_or_malformed_window_fails_closed(self):
        obs = {
            "prices": [100.0] * 30,
            "closeTimesMs": [i * 1000 for i in range(30)],
            "decisionTimeMs": 29000,
        }
        for window in (10, 21, "bad", None):
            with self.subTest(window=window):
                snapshot = calculate(obs, {"window": window})
                self.assertFalse(snapshot["valid"])
                self.assertEqual(snapshot["reasonCode"], "invalid_config")

    def test_schema_version_matches_ts(self):
        self.assertEqual(SCHEMA_VERSION, "regime-snapshot-v1")
        self.assertEqual(POLICY_VERSION, "regime-entry-policy-v1")

    def test_entry_policy_blocks_persistent_stress(self):
        d = entry_policy({"valid": True, "regime": "persistent_stress"})
        self.assertFalse(d["allow"])
        self.assertEqual(d["reasonCode"], "blocked_persistent_stress")

    def test_entry_policy_blocks_unknown(self):
        d = entry_policy({"valid": False, "regime": "UNKNOWN"})
        self.assertFalse(d["allow"])
        self.assertEqual(d["reasonCode"], "blocked_unknown")

    def test_entry_policy_allows_valid(self):
        for regime in ("calm", "onset", "recovery"):
            with self.subTest(regime=regime):
                d = entry_policy({"valid": True, "regime": regime})
                self.assertTrue(d["allow"])

    def test_unknown_insufficient_data(self):
        s = classify([100, 101, 102, 103, 104], [0, 1000, 2000, 3000, 4000], 4000)
        self.assertEqual(s["regime"], "UNKNOWN")
        self.assertFalse(s["valid"])

    def test_unknown_nan_input(self):
        prices = [100.0] * 30
        prices[15] = float("nan")
        times = [i * 1000 for i in range(30)]
        s = classify(prices, times, 29000)
        self.assertEqual(s["regime"], "UNKNOWN")

    def test_unknown_non_monotonic_timestamps(self):
        prices = [100.0] * 30
        times = [i * 1000 for i in range(30)]
        times[10] = times[9]  # duplicate
        s = classify(prices, times, 29000)
        self.assertEqual(s["regime"], "UNKNOWN")

    def test_valid_snapshot_has_features(self):
        prices = [100.0 + i * 0.1 for i in range(30)]
        times = [i * 1000 for i in range(30)]
        s = classify(prices, times, 29000)
        self.assertTrue(s["valid"])
        self.assertIsNotNone(s["vol"])
        self.assertIsNotNone(s["drawdown"])
        self.assertIsNotNone(s["volOfVol"])
        self.assertLessEqual(s["observationEndMs"], s["decisionTimeMs"])

    def test_causal_boundary(self):
        prices = [100.0] * 30
        times = [i * 1000 for i in range(30)]
        # observation ends at 29000, decision at 29000 (bar is closed)
        s = classify(prices, times, 29000)
        self.assertTrue(s["valid"])
        # observation ends after decision → UNKNOWN
        s2 = classify(prices, times, 28999)
        self.assertEqual(s2["regime"], "UNKNOWN")

    def test_priority_calm_beats_recovery(self):
        # Very flat, low-vol prices → calm
        flat = [100.0 + (0.001 if i % 2 == 0 else -0.001) for i in range(30)]
        times = [i * 1000 for i in range(30)]
        s = classify(flat, times, 29000)
        self.assertEqual(s["regime"], "calm")


class TestRegimeGateValidation(unittest.TestCase):

    def test_valid_observation(self):
        prices = [100.0] * 30
        times = [float(i * 1000) for i in range(30)]
        self.assertIsNone(_validate_observation(prices, times, 29000))

    def test_mismatched_lengths(self):
        self.assertEqual(_validate_observation([1, 2], [1], 1000), "invalid_config")

    def test_non_finite_decision_time(self):
        self.assertEqual(_validate_observation([100]*30, [i*1000 for i in range(30)], float("nan")), "invalid_config")

    def test_gap_too_large(self):
        prices = [100.0] * 30
        times = [float(i * 1000) for i in range(30)]
        times[20] = times[19] + 400_000  # >300s max gap
        for j in range(21, 30):
            times[j] = times[j - 1] + 1000
        self.assertEqual(_validate_observation(prices, times, times[29]), "timestamp_gap")


if __name__ == "__main__":
    unittest.main()
