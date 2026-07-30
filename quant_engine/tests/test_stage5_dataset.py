from __future__ import annotations

import copy
import math
import unittest
from datetime import datetime, timezone
from pathlib import Path

from quant_engine.proof.stage5_dataset import (
    BINANCE_KLINES_ENDPOINT,
    INTERVAL_MS,
    PHASES,
    audit_ohlcv_rows,
    build_stage5_dataset_manifest,
    fetch_public_binance_klines,
    verify_stage5_dataset_manifest,
)
from quant_engine.proof.stage5_evaluation import build_stage5_evaluation_spec, canonical_json_bytes


ROOT = Path(__file__).resolve().parents[2]
ENTRY = (ROOT / "tests/fixtures/stage-5-evaluation/stage-5-entry-gate.json").read_bytes()
EVAL_SOURCE = "913646777a64aa801c7dc263701802249164bf97"
SOURCE = "a" * 40
EVAL_RAW = canonical_json_bytes(build_stage5_evaluation_spec(EVAL_SOURCE, ENTRY)) + b"\n"


def row(open_time: int, *, close: str = "10.5") -> list:
    return [open_time, "10", "11", "9", close, "100", open_time + INTERVAL_MS - 1, "0", 1, "0", "0", "0"]


def audit_stub(symbol: str, phase: str) -> dict:
    start, end, count = PHASES[phase]
    value = {
        "symbol": symbol,
        "canonicalSymbol": symbol.removesuffix("USDT") + "/USDT",
        "timeframe": "5m",
        "phase": phase,
        "startInclusive": datetime.fromtimestamp(start / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
        "endExclusive": datetime.fromtimestamp(end / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
        "startMs": start,
        "endExclusiveMs": end,
        "rowCount": count,
        "expectedRowCount": count,
        "timezone": "UTC",
        "gapPolicy": "reject",
        "duplicatePolicy": "reject",
        "missingBars": 0,
        "duplicateBars": 0,
        "rawRowsSha256": "1" * 64,
        "normalizedSha256": "2" * 64,
        "ohlcValid": True,
    }
    from quant_engine.proof.stage5_evaluation import canonical_sha256
    value["datasetId"] = canonical_sha256(value)
    return value


def matrix() -> list[dict]:
    return [audit_stub(symbol, phase) for phase in ("TRAIN", "VALIDATION") for symbol in ("BNBUSDT", "BTCUSDT", "ETHUSDT", "SOLUSDT")]


class DatasetAuditTests(unittest.TestCase):
    def test_valid_rows_have_deterministic_audit(self) -> None:
        rows = [row(0), row(INTERVAL_MS), row(2 * INTERVAL_MS)]
        first = audit_ohlcv_rows(rows, "BTCUSDT", "TRAIN", 0, 3 * INTERVAL_MS)
        second = audit_ohlcv_rows(rows, "BTCUSDT", "TRAIN", 0, 3 * INTERVAL_MS)
        self.assertEqual(first, second)
        self.assertEqual(first["missingBars"], 0)
        self.assertEqual(first["duplicateBars"], 0)

    def test_gap_duplicate_and_count_fail_closed(self) -> None:
        bad_sets = [
            [row(0), row(2 * INTERVAL_MS)],
            [row(0), row(0), row(2 * INTERVAL_MS)],
            [row(0)],
        ]
        for rows in bad_sets:
            with self.assertRaises(ValueError):
                audit_ohlcv_rows(rows, "BTCUSDT", "TRAIN", 0, 3 * INTERVAL_MS)

    def test_invalid_ohlc_volume_and_number_reject(self) -> None:
        bad = row(0); bad[2] = "9"
        negative_volume = row(0); negative_volume[5] = "-1"
        nonfinite = row(0); nonfinite[4] = "NaN"
        for candidate in (bad, negative_volume, nonfinite):
            with self.assertRaises(ValueError):
                audit_ohlcv_rows([candidate], "BTCUSDT", "TRAIN", 0, INTERVAL_MS)

    def test_invalid_close_time_shape_and_scope_reject(self) -> None:
        bad_close = row(0); bad_close[6] += 1
        with self.assertRaises(ValueError):
            audit_ohlcv_rows([bad_close], "BTCUSDT", "TRAIN", 0, INTERVAL_MS)
        with self.assertRaises(ValueError):
            audit_ohlcv_rows([[0] * 11], "BTCUSDT", "TRAIN", 0, INTERVAL_MS)
        with self.assertRaises(ValueError):
            audit_ohlcv_rows([row(0)], "XRPUSDT", "TRAIN", 0, INTERVAL_MS)

    def test_fetch_paginates_without_auth_and_exact_endpoint(self) -> None:
        calls = []
        base = PHASES["TRAIN"][0]
        source = [row(base + index * INTERVAL_MS) for index in range(1001)]

        def fake(url, params):
            calls.append((url, dict(params)))
            start_index = (params["startTime"] - base) // INTERVAL_MS
            return source[start_index:start_index + 1000]

        result = fetch_public_binance_klines("BTCUSDT", base, base + 1001 * INTERVAL_MS, fake)
        self.assertEqual(len(result), 1001)
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call[0] == BINANCE_KLINES_ENDPOINT for call in calls))
        self.assertTrue(all(set(call[1]) == {"symbol", "interval", "startTime", "endTime", "limit"} for call in calls))

    def test_fetch_rejects_locked_test_and_unknown_symbol(self) -> None:
        with self.assertRaises(ValueError):
            fetch_public_binance_klines("BTCUSDT", PHASES["LOCKED_TEST"][0], PHASES["LOCKED_TEST"][1], lambda *_: [])
        with self.assertRaises(ValueError):
            fetch_public_binance_klines("XRPUSDT", 0, INTERVAL_MS, lambda *_: [])

    def test_fetch_rejects_empty_overlap_out_of_range_and_no_progress(self) -> None:
        base = PHASES["TRAIN"][0]
        with self.assertRaises(ValueError):
            fetch_public_binance_klines("BTCUSDT", base, base + INTERVAL_MS, lambda *_: [])
        overlap = [row(base), row(base)]
        with self.assertRaises(ValueError):
            fetch_public_binance_klines("BTCUSDT", base, base + 2 * INTERVAL_MS, lambda *_: overlap)
        with self.assertRaises(ValueError):
            fetch_public_binance_klines(
                "BTCUSDT", base, base + INTERVAL_MS, lambda *_: [row(base + INTERVAL_MS)]
            )


class DatasetManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.datasets = matrix()
        self.manifest = build_stage5_dataset_manifest(SOURCE, EVAL_RAW, self.datasets)

    def test_exact_matrix_source_and_identity(self) -> None:
        self.assertEqual(len(self.manifest["datasets"]), 8)
        self.assertEqual(self.manifest["evaluationSpec"]["rawSha256"], "62bf8ccf9fc18b2818c1d24d05426128092e5dd464760daed89986a947adbc1b")
        unsigned = copy.deepcopy(self.manifest); identity = unsigned.pop("datasetManifestId")
        from quant_engine.proof.stage5_evaluation import canonical_sha256
        self.assertEqual(identity, canonical_sha256(unsigned))

    def test_locked_test_remains_sealed_and_unhashed(self) -> None:
        locked = self.manifest["splitManifest"]["LOCKED_TEST"]
        self.assertEqual(locked["state"], "SEALED_UNOPENED")
        self.assertEqual(locked["accessCount"], 0)
        self.assertIsNone(locked["rawRowsSha256"])
        self.assertIsNone(locked["normalizedSha256"])

    def test_split_feature_and_leakage_contracts(self) -> None:
        self.assertEqual(self.manifest["splitManifest"]["purgeBars"], 96)
        self.assertEqual(self.manifest["splitManifest"]["embargoBars"], 96)
        self.assertEqual(self.manifest["splitManifest"]["warmupBars"], 100)
        self.assertEqual(self.manifest["leakageAudit"]["result"], "PASS")
        self.assertFalse(self.manifest["featureAvailabilityContract"]["fitAcrossSplitsAllowed"])

    def test_public_source_has_no_auth_or_committed_data(self) -> None:
        source = self.manifest["marketDataSource"]
        self.assertEqual(source["securityType"], "NONE")
        self.assertFalse(source["apiKeyUsed"])
        self.assertFalse(source["dataFilesCommitted"])
        self.assertTrue(source["privateProofBundle"])

    def test_safety_is_fail_closed(self) -> None:
        self.assertEqual(self.manifest["safety"]["paperTestnetLiveCalls"], 0)
        for key in ("activationAuthorized", "runtimeStarted", "paperApproved", "testnetApproved", "liveApproved"):
            self.assertFalse(self.manifest["safety"][key])

    def test_manifest_rejects_cardinality_duplicate_and_bad_count(self) -> None:
        with self.assertRaises(ValueError):
            build_stage5_dataset_manifest(SOURCE, EVAL_RAW, self.datasets[:-1])
        duplicate = copy.deepcopy(self.datasets); duplicate[-1] = copy.deepcopy(duplicate[0])
        with self.assertRaises(ValueError):
            build_stage5_dataset_manifest(SOURCE, EVAL_RAW, duplicate)
        bad_count = copy.deepcopy(self.datasets); bad_count[0]["rowCount"] -= 1
        with self.assertRaises(ValueError):
            build_stage5_dataset_manifest(SOURCE, EVAL_RAW, bad_count)

    def test_manifest_rejects_forged_dataset_identity_and_display_range(self) -> None:
        forged_id = copy.deepcopy(self.datasets)
        forged_id[0]["rawRowsSha256"] = "f" * 64
        with self.assertRaises(ValueError):
            build_stage5_dataset_manifest(SOURCE, EVAL_RAW, forged_id)
        forged_range = copy.deepcopy(self.datasets)
        forged_range[0]["startInclusive"] = "2099-01-01T00:00:00Z"
        from quant_engine.proof.stage5_evaluation import canonical_sha256
        unsigned = dict(forged_range[0]); unsigned.pop("datasetId")
        forged_range[0]["datasetId"] = canonical_sha256(unsigned)
        with self.assertRaises(ValueError):
            build_stage5_dataset_manifest(SOURCE, EVAL_RAW, forged_range)

    def test_evaluation_raw_and_source_binding(self) -> None:
        with self.assertRaises(ValueError):
            build_stage5_dataset_manifest(SOURCE, EVAL_RAW + b" ", self.datasets)
        with self.assertRaises(ValueError):
            build_stage5_dataset_manifest("A" * 40, EVAL_RAW, self.datasets)

    def test_verifier_rejects_mutation_extra_missing_bool_and_nonfinite(self) -> None:
        candidates = []
        changed = copy.deepcopy(self.manifest); changed["leakageAudit"]["result"] = "FAIL"; candidates.append(changed)
        extra = copy.deepcopy(self.manifest); extra["override"] = True; candidates.append(extra)
        missing = copy.deepcopy(self.manifest); del missing["safety"]; candidates.append(missing)
        boolean = copy.deepcopy(self.manifest); boolean["splitManifest"]["purgeBars"] = True; candidates.append(boolean)
        nonfinite = copy.deepcopy(self.manifest); nonfinite["splitManifest"]["purgeBars"] = math.inf; candidates.append(nonfinite)
        for candidate in candidates:
            with self.assertRaises(ValueError):
                verify_stage5_dataset_manifest(candidate, SOURCE, EVAL_RAW)

    def test_verifier_does_not_mutate_caller(self) -> None:
        caller = copy.deepcopy(self.manifest)
        before = canonical_json_bytes(caller)
        verify_stage5_dataset_manifest(caller, SOURCE, EVAL_RAW)
        self.assertEqual(before, canonical_json_bytes(caller))


if __name__ == "__main__":
    unittest.main()
