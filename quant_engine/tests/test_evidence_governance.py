"""Adversarial Stage 4A13 evidence-governance tests."""

from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from quant_engine.proof.asset_manifest import build_asset_manifest
from quant_engine.proof.evidence_governance import (
    EvidenceLedger,
    build_consumed_evidence_seed,
    build_failure_attribution,
    build_governance_attestation_subject,
    build_governance_contract,
    evidence_window_fingerprint,
    fresh_window_id,
    strategy_semantic_fingerprint,
    verify_consumed_evidence_seed,
    verify_governance_contract,
    verify_strategy_lineage,
)
from quant_engine.proof.promotion_receipt import build_promotion_receipt
from quant_engine.proof.strategy_spec import build_candidate_manifest, canonical_sha256


REPO = Path(__file__).resolve().parents[2]
ENGINE = "34db3886eb2f0e19f5a8b453f2c0039e264a946e"
BASELINE = "eadb12943efb7d575b4cec6b0d381a4d5ca42db2"


def aggregate(value: float = -0.01, positive_fraction: float = 0.2, drawdown: float = 0.1) -> dict:
    return {
        "datasetCount": 10,
        "meanNetReturn": value,
        "medianNetReturn": value,
        "worstNetReturn": value - 0.01,
        "positiveDatasetCount": round(positive_fraction * 10),
        "positiveDatasetFraction": positive_fraction,
        "totalTrades": 100,
        "maxDrawdown": drawdown,
    }


def dataset_matrix() -> list[dict]:
    return [
        {
            "datasetId": canonical_sha256({"dataset": index}),
            "symbol": f"S{index}/USDT",
            "timeframe": "5m" if index < 8 else "4h",
            "sourceDataframeSha256": "3" * 64,
            "workingDataframeSha256": "4" * 64,
            "sourceSha256": "5" * 64,
            "sourceRows": 9_000,
            "workingStartRow": 0,
            "workingEndRowExclusive": 9_000,
            "workingRows": 9_000,
            "gapPolicy": "reject",
            "gapCount": 0,
            "segmentIndex": 0,
        }
        for index in range(10)
    ]


def development_fixture(manifest: dict, *, self_hash: bool = True) -> dict:
    matrix = dataset_matrix()
    strategies = []
    for spec in manifest["specs"]:
        folds = []
        for fold_index in range(3):
            parameter_id = canonical_sha256({"strategy": spec["strategyId"], "fold": fold_index})
            folds.append({
                "fold": fold_index,
                "selectionPhase": "train-only",
                "selectionCount": 3,
                "selectedParameterId": parameter_id,
                "trainCandidates": [{"parameterId": parameter_id, "aggregate": aggregate(-0.05)}],
                "validation": {"aggregate": aggregate(-0.02), "perDataset": [{"datasetId": item["datasetId"], "netReturn": -0.02, "tradeCount": 10, "maxDrawdown": 0.1} for item in matrix]},
                "test": {"aggregate": aggregate(-0.01), "perDataset": [{"datasetId": item["datasetId"], "netReturn": -0.01, "tradeCount": 10, "maxDrawdown": 0.1} for item in matrix]},
                "stressTest": {"aggregate": aggregate(-0.03), "perDataset": [{"datasetId": item["datasetId"], "netReturn": -0.03, "tradeCount": 10, "maxDrawdown": 0.1} for item in matrix]},
                "parameterStability": {"passed": True, "maxMedianReturnDelta": 0.01},
                "validationAndTestUsedForFitting": False,
            })
        strategies.append({
            "strategyId": spec["strategyId"],
            "specId": spec["specId"],
            "selectionCountTotal": 9,
            "folds": folds,
        })
    report = {
        "schemaVersion": "stage-4a12.robustness-development.v1",
        "sourceCommit": ENGINE,
        "config": {
            "min_positive_market_fraction": 0.6,
            "min_stress_test_return": -0.02,
            "max_holdout_drawdown": 0.25,
        },
        "datasetMatrix": matrix,
        "datasetMatrixId": "6" * 64,
        "candidateCount": 4,
        "reportedCandidateCount": 4,
        "selectionPolicy": "train-only-cross-market-penalized",
        "finalHoldoutEvaluationCount": 0,
        "strategies": strategies,
        "isolationVerified": True,
    }
    report["developmentId"] = canonical_sha256(report) if self_hash else "7" * 64
    return report


def final_and_ledger(manifest: dict, development: dict) -> tuple[dict, dict, dict]:
    legacy_entries = {}
    decisions = []
    for spec in manifest["specs"]:
        per_dataset = []
        for index, dataset in enumerate(development["datasetMatrix"]):
            result = {
                "start": 7_650,
                "endExclusive": 9_000,
                "decisionCalls": 1_349,
                "firstEntryIndex": 7_700,
                "tradeCount": 10,
                "netReturn": -0.01,
                "maxDrawdown": 0.1,
                "winRate": 0.4,
                "tradesSha256": canonical_sha256({"strategy": spec["strategyId"], "dataset": index}),
            }
            ledger_key = canonical_sha256({"strategy": spec["strategyId"], "dataset": index, "window": "holdout"})
            legacy_entries[ledger_key] = {
                "runId": "stage-4a12-test",
                "evaluationCount": 1,
                "status": "consumed",
                "resultDigest": canonical_sha256(result),
            }
            per_dataset.append({"datasetId": dataset["datasetId"], "ledgerKey": ledger_key, **result})
        decisions.append({
            "strategyId": spec["strategyId"],
            "specId": spec["specId"],
            "deploymentParameterId": "8" * 64,
            "finalHoldoutEvaluationCount": 10,
            "expectedFinalHoldoutEvaluationCount": 10,
            "finalHoldout": {"perDataset": per_dataset, "aggregate": aggregate(-0.01)},
            "robustnessPassed": False,
            "promotionEligible": False,
            "promotionReasons": ["FINAL_HOLDOUT_NOT_POSITIVE"],
            "paperReadinessReview": False,
            "paperApproved": False,
            "testnetApproved": False,
            "liveApproved": False,
        })
    final = {
        "schemaVersion": "stage-4a12.robustness-final.v1",
        "sourceCommit": ENGINE,
        "developmentId": development["developmentId"],
        "datasetMatrixId": development["datasetMatrixId"],
        "candidateCount": 4,
        "backtestCompletedCount": 4,
        "robustnessPassedCount": 0,
        "promotionEligibleCount": 0,
        "finalHoldoutEvaluationCount": 40,
        "expectedFinalHoldoutEvaluationCount": 40,
        "holdoutRunId": "stage-4a12-test",
        "decisions": decisions,
        "approvals": {"paperApproved": False, "testnetApproved": False, "liveApproved": False},
    }
    final["proofId"] = canonical_sha256(final)
    receipt_development = copy.deepcopy(development)
    receipt = build_promotion_receipt(receipt_development, final, manifest, ENGINE)
    return final, {"schemaVersion": "stage-4a12.holdout-ledger.v1", "entries": legacy_entries}, receipt


def legacy_boundaries(development: dict) -> dict[str, dict]:
    return {
        item["datasetId"]: {
            "start": 7_650,
            "endExclusive": 9_000,
            "opensAt": "2026-01-01T00:00:00Z",
            "closesAt": "2026-06-01T00:00:00Z",
            "windowDataSha256": canonical_sha256({"window": item["datasetId"]}),
        }
        for item in development["datasetMatrix"]
    }


def fresh_window(status: str = "SEALED") -> dict:
    window = {
        "schemaVersion": "stage-4a13.fresh-evidence-window.v1",
        "datasetId": "9" * 64,
        "predecessorWindowId": "a" * 64,
        "symbol": "BTC/USDT",
        "timeframe": "4h",
        "opensAt": "2027-01-01T00:00:00Z",
        "closesAt": "2027-07-01T00:00:00Z",
        "gapPolicy": "reject",
        "segmentPolicy": None,
        "sourceDataframeSha256": "b" * 64 if status == "SEALED" else None,
        "windowDataSha256": "c" * 64 if status == "SEALED" else None,
        "evidenceFingerprint": None,
        "startRow": 9_000 if status == "SEALED" else None,
        "endRowExclusive": 10_200 if status == "SEALED" else None,
        "status": status,
    }
    window["windowId"] = fresh_window_id(window)
    if status == "SEALED":
        window["evidenceFingerprint"] = evidence_window_fingerprint(window)
    return window


def lineage_for(spec: dict, window: dict, consumed: list[str], parent: dict | None = None) -> dict:
    lineage = {
        "strategyId": spec["strategyId"],
        "specId": spec["specId"],
        "parentStrategyId": parent["strategyId"] if parent else None,
        "parentSpecId": parent["specId"] if parent else None,
        "researchEvidenceCutoff": "2026-12-01T00:00:00Z",
        "designEvidenceWindowIds": ["c" * 64],
        "consumedHoldoutWindowIds": consumed,
        "designInputs": ["d" * 64],
        "freezeCommit": "e" * 40,
        "freezeTimestamp": "2026-12-15T00:00:00Z",
        "freshEvidenceWindowId": window["windowId"],
        "semanticFingerprint": strategy_semantic_fingerprint(spec),
        "lineageRootId": parent["lineageRootId"] if parent else canonical_sha256({"semanticFingerprint": strategy_semantic_fingerprint(spec)}),
    }
    lineage["lineageId"] = canonical_sha256(lineage)
    return lineage


class FailureAttributionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assets = build_asset_manifest(REPO, ENGINE)
        cls.manifest = build_candidate_manifest(assets, ENGINE)

    def test_attribution_is_deterministic_and_contains_no_holdout_metrics(self):
        development = development_fixture(self.manifest)
        first = build_failure_attribution(development, self.manifest, BASELINE)
        second = build_failure_attribution(copy.deepcopy(development), self.manifest, BASELINE)
        self.assertEqual(first, second)
        serialized = json.dumps(first, sort_keys=True)
        self.assertNotIn('"finalHoldout":', serialized)
        self.assertFalse(first["finalHoldoutUsedForAttribution"])
        self.assertFalse(first["finalHoldoutUsedForDesign"])
        self.assertEqual(len(first["diagnostics"]), 4)
        self.assertEqual(len(first["gateGapAudit"]), 4)
        self.assertTrue(all(not item["causalClaim"] for item in first["diagnostics"]))

    def test_tampered_or_nonisolated_development_fails_closed(self):
        development = development_fixture(self.manifest)
        development["strategies"][0]["folds"][0]["validationAndTestUsedForFitting"] = True
        development["developmentId"] = canonical_sha256({key: value for key, value in development.items() if key != "developmentId"})
        with self.assertRaisesRegex(ValueError, "NON_DEVELOPMENT_FITTING"):
            build_failure_attribution(development, self.manifest, BASELINE)

    def test_consumed_seed_is_exact_and_source_free(self):
        development = development_fixture(self.manifest)
        final, legacy, receipt = final_and_ledger(self.manifest, development)
        seed = build_consumed_evidence_seed(final, legacy, receipt, self.manifest, legacy_boundaries(development))
        self.assertEqual(seed["windowCount"], 10)
        self.assertEqual(seed["evaluationCount"], 40)
        self.assertEqual(len({item["evaluationId"] for item in seed["evaluations"]}), 40)
        self.assertNotIn("netReturn", str(seed))
        self.assertTrue(all(item["state"] == "CONSUMED" for item in seed["evaluations"]))
        verify_consumed_evidence_seed(seed, receipt, self.manifest)

    def test_legacy_ledger_tamper_is_rejected(self):
        development = development_fixture(self.manifest)
        final, legacy, receipt = final_and_ledger(self.manifest, development)
        first = next(iter(legacy["entries"].values()))
        first["evaluationCount"] = 2
        with self.assertRaisesRegex(ValueError, "NOT_CONSUMED"):
            build_consumed_evidence_seed(final, legacy, receipt, self.manifest, legacy_boundaries(development))

    def test_rewrapped_consumed_data_is_not_fresh_even_with_new_semantics(self):
        development = development_fixture(self.manifest)
        final, legacy, receipt = final_and_ledger(self.manifest, development)
        seed = build_consumed_evidence_seed(final, legacy, receipt, self.manifest, legacy_boundaries(development))
        consumed = seed["windows"][0]
        rewrapped = {
            "schemaVersion": "stage-4a13.fresh-evidence-window.v1",
            "datasetId": consumed["datasetId"],
            "predecessorWindowId": consumed["windowId"],
            "symbol": "RENAMED/USDT",
            "timeframe": "5m",
            "opensAt": consumed["opensAt"],
            "closesAt": consumed["closesAt"],
            "gapPolicy": "reject",
            "segmentPolicy": None,
            "sourceDataframeSha256": "9" * 64,
            "windowDataSha256": consumed["windowDataSha256"],
            "evidenceFingerprint": consumed["evidenceFingerprint"],
            "startRow": 0,
            "endRowExclusive": 1_350,
            "status": "SEALED",
        }
        rewrapped["windowId"] = fresh_window_id(rewrapped)
        with tempfile.TemporaryDirectory() as directory:
            ledger = EvidenceLedger(Path(directory) / "ledger.json")
            ledger.import_seed(seed)
            with self.assertRaisesRegex(ValueError, "CONSUMED_EVIDENCE_WINDOW_REUSE_DETECTED"):
                ledger.reserve("0" * 64, rewrapped, "new-strategy", "1" * 64)


class LineageAndLedgerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assets = build_asset_manifest(REPO, ENGINE)
        cls.manifest = build_candidate_manifest(assets, ENGINE)
        cls.spec = cls.manifest["specs"][0]

    def test_lineage_requires_consumed_history_and_freeze_before_window(self):
        window = fresh_window("PLANNED")
        consumed = ["f" * 64]
        lineage = lineage_for(self.spec, window, consumed)
        verify_strategy_lineage(lineage, self.spec, consumed, window)
        omitted = copy.deepcopy(lineage)
        omitted["consumedHoldoutWindowIds"] = []
        omitted["lineageId"] = canonical_sha256({key: value for key, value in omitted.items() if key != "lineageId"})
        with self.assertRaisesRegex(ValueError, "CONSUMED_EVIDENCE_OMITTED"):
            verify_strategy_lineage(omitted, self.spec, consumed, window)

    def test_parent_version_cannot_reset_lineage_root(self):
        window = fresh_window("PLANNED")
        parent = lineage_for(self.spec, window, ["f" * 64])
        child_spec = copy.deepcopy(self.spec)
        child_spec["strategyId"] = "new-derived-id"
        child_spec["version"] = "99"
        child_spec["specId"] = "1" * 64
        child = lineage_for(child_spec, window, ["f" * 64], parent)
        child["lineageRootId"] = "2" * 64
        child["lineageId"] = canonical_sha256({key: value for key, value in child.items() if key != "lineageId"})
        with self.assertRaisesRegex(ValueError, "LINEAGE_ROOT_RESET"):
            verify_strategy_lineage(child, child_spec, ["f" * 64], window, parent)

    def test_new_id_version_or_copy_cannot_reuse_same_window(self):
        window = fresh_window()
        original_fingerprint = strategy_semantic_fingerprint(self.spec)
        copied = copy.deepcopy(self.spec)
        copied["strategyId"] = "renamed-copy"
        copied["version"] = "999"
        copied["specId"] = "3" * 64
        self.assertEqual(original_fingerprint, strategy_semantic_fingerprint(copied))
        relabelled_window = copy.deepcopy(window)
        relabelled_window["symbol"] = "XBT/USDT"
        relabelled_window["windowId"] = fresh_window_id(relabelled_window)
        self.assertNotEqual(window["windowId"], relabelled_window["windowId"])
        self.assertEqual(window["evidenceFingerprint"], relabelled_window["evidenceFingerprint"])
        with tempfile.TemporaryDirectory() as directory:
            ledger = EvidenceLedger(Path(directory) / "evidence-ledger.json")
            evaluation_id = ledger.reserve(original_fingerprint, window, self.spec["strategyId"], self.spec["specId"])
            with self.assertRaisesRegex(ValueError, "CONSUMED_EVIDENCE_WINDOW_REUSE_DETECTED"):
                ledger.reserve(strategy_semantic_fingerprint(copied), relabelled_window, copied["strategyId"], copied["specId"])
            ledger.complete(evaluation_id, "4" * 64)
            with self.assertRaisesRegex(ValueError, "CONSUMED_EVIDENCE_WINDOW_REUSE_DETECTED"):
                ledger.reserve(original_fingerprint, window, "another-id", "5" * 64)

    def test_reservation_is_consumption_even_if_not_completed(self):
        window = fresh_window()
        with tempfile.TemporaryDirectory() as directory:
            ledger = EvidenceLedger(Path(directory) / "evidence-ledger.json")
            fingerprint = strategy_semantic_fingerprint(self.spec)
            ids = ledger.reserve_batch([
                {"semanticFingerprint": fingerprint, "strategyId": self.spec["strategyId"], "specId": self.spec["specId"]},
                {"semanticFingerprint": "9" * 64, "strategyId": "second-frozen-family", "specId": "8" * 64},
            ], window)
            self.assertEqual(len(ids), 2)
            with self.assertRaisesRegex(ValueError, "CONSUMED_EVIDENCE_WINDOW_REUSE_DETECTED"):
                ledger.reserve(fingerprint, window, "changed-id", "6" * 64)

    def test_1h_window_requires_explicit_segment_policy(self):
        window = fresh_window()
        window["timeframe"] = "1h"
        window["windowId"] = fresh_window_id(window)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "1H_SEGMENT_POLICY_REQUIRED"):
                EvidenceLedger(Path(directory) / "ledger.json").reserve("7" * 64, window, "strategy", "8" * 64)

    def test_window_id_cannot_be_relabelled(self):
        window = fresh_window()
        window["windowId"] = "0" * 64
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "WINDOW_ID_INVALID"):
                EvidenceLedger(Path(directory) / "ledger.json").reserve("7" * 64, window, "strategy", "8" * 64)

    def test_contract_and_attestation_fail_closed_without_fresh_evidence(self):
        contract = build_governance_contract(BASELINE)
        verify_governance_contract(contract)
        self.assertEqual(contract["nextGenerationFrozenSpecCount"], 0)
        self.assertFalse(contract["freshPromotionProofAllowed"])
        report = {"reportId": "1" * 64}
        seed = {"seedId": "2" * 64}
        subject = build_governance_attestation_subject(report, seed, contract, "3" * 40)
        self.assertEqual(subject["receiptCommit"], "3" * 40)
        self.assertFalse(subject["paperApproved"])

    def test_planned_window_id_survives_sealing_but_data_fingerprint_is_separate(self):
        planned = fresh_window("PLANNED")
        sealed = copy.deepcopy(planned)
        sealed.update({
            "status": "SEALED",
            "sourceDataframeSha256": "b" * 64,
            "windowDataSha256": "c" * 64,
            "startRow": 9_000,
            "endRowExclusive": 10_200,
        })
        sealed["evidenceFingerprint"] = evidence_window_fingerprint(sealed)
        self.assertEqual(planned["windowId"], fresh_window_id(sealed))
        self.assertNotEqual(planned.get("evidenceFingerprint"), sealed["evidenceFingerprint"])


if __name__ == "__main__":
    unittest.main()
