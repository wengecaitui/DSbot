"""Stage 4A13 failure attribution and evidence-contamination governance.

This module deliberately separates development diagnostics from consumed
holdout evidence.  Holdout results may seed the consumed-evidence ledger, but
they can never enter failure attribution or strategy design inputs.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Mapping, Sequence

from .promotion_receipt import verify_promotion_receipt
from .strategy_spec import canonical_sha256


SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
ATTRIBUTION_LABELS = [
    "DEVELOPMENT EVIDENCE ONLY",
    "FINAL HOLDOUT EXCLUDED FROM ATTRIBUTION AND DESIGN",
    "NOT APPROVED FOR PAPER, TESTNET OR LIVE",
]
LEDGER_LABELS = [
    "APPEND-ONLY CONSUMED EVIDENCE LEDGER",
    "RESERVATION IS CONSUMPTION",
    "IDENTITY CHANGES DO NOT RESET EVIDENCE STATE",
]


def _parse_timestamp(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError) as error:
        raise ValueError("EVIDENCE_TIMESTAMP_INVALID") from error
    if parsed.tzinfo is None:
        raise ValueError("EVIDENCE_TIMESTAMP_NOT_UTC")
    return parsed


def _verify_self_digest(payload: Mapping[str, Any], field: str, error: str) -> None:
    unsigned = dict(payload)
    digest = unsigned.pop(field, None)
    if not SHA256_PATTERN.fullmatch(str(digest or "")) or digest != canonical_sha256(unsigned):
        raise ValueError(error)


def strategy_semantic_fingerprint(spec: Mapping[str, Any]) -> str:
    """Hash executable semantics while ignoring mutable identity and lineage labels."""
    ignored = {
        "strategyId",
        "specId",
        "version",
        "label",
        "parentStrategyId",
        "parentSpecId",
        "lineage",
    }
    semantic = {key: value for key, value in spec.items() if key not in ignored}
    if not semantic:
        raise ValueError("STRATEGY_SEMANTICS_EMPTY")
    return canonical_sha256(semantic)


def verify_development_report(development: Mapping[str, Any]) -> None:
    if development.get("schemaVersion") != "stage-4a12.robustness-development.v1":
        raise ValueError("ATTRIBUTION_DEVELOPMENT_SCHEMA_INVALID")
    _verify_self_digest(development, "developmentId", "ATTRIBUTION_DEVELOPMENT_ID_INVALID")
    if development.get("finalHoldoutEvaluationCount") != 0 or development.get("isolationVerified") is not True:
        raise ValueError("ATTRIBUTION_DEVELOPMENT_NOT_ISOLATED")
    strategies = development.get("strategies")
    if not isinstance(strategies, list) or len(strategies) != development.get("candidateCount"):
        raise ValueError("ATTRIBUTION_STRATEGY_SET_INVALID")
    for strategy in strategies:
        for fold in strategy.get("folds", []):
            if fold.get("selectionPhase") != "train-only" or fold.get("validationAndTestUsedForFitting") is not False:
                raise ValueError("ATTRIBUTION_NON_DEVELOPMENT_FITTING_DETECTED")


def _selected_train_aggregate(fold: Mapping[str, Any]) -> Mapping[str, Any]:
    selected = [item for item in fold["trainCandidates"] if item["parameterId"] == fold["selectedParameterId"]]
    if len(selected) != 1:
        raise ValueError("ATTRIBUTION_SELECTED_TRAIN_RESULT_INVALID")
    return selected[0]["aggregate"]


def _development_slice_summary(records: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    if not records:
        raise ValueError("ATTRIBUTION_DEVELOPMENT_SLICE_EMPTY")
    returns = [float(item["netReturn"]) for item in records]
    trades = [int(item["tradeCount"]) for item in records]
    return {
        "evaluationCount": len(records),
        "meanNetReturn": sum(returns) / len(returns),
        "positiveEvaluationCount": sum(value > 0 for value in returns),
        "positiveEvaluationFraction": sum(value > 0 for value in returns) / len(returns),
        "totalTrades": sum(trades),
        "meanTradesPerEvaluation": sum(trades) / len(trades),
        "maxDrawdown": max(float(item["maxDrawdown"]) for item in records),
    }


def build_failure_attribution(
    development: Mapping[str, Any],
    candidate_manifest: Mapping[str, Any],
    baseline_commit: str,
) -> dict[str, Any]:
    """Build deterministic diagnostics using development phases only."""
    verify_development_report(development)
    if not COMMIT_PATTERN.fullmatch(baseline_commit):
        raise ValueError("ATTRIBUTION_BASELINE_COMMIT_INVALID")
    _verify_self_digest(candidate_manifest, "manifestId", "ATTRIBUTION_MANIFEST_ID_INVALID")
    specs = {item["strategyId"]: item for item in candidate_manifest.get("specs", [])}
    strategies = development["strategies"]
    if set(specs) != {item["strategyId"] for item in strategies}:
        raise ValueError("ATTRIBUTION_MANIFEST_STRATEGY_MISMATCH")

    minimum_fraction = float(development["config"]["min_positive_market_fraction"])
    stress_floor = float(development["config"]["min_stress_test_return"])
    drawdown_limit = float(development["config"]["max_holdout_drawdown"])
    diagnostics = []
    all_test_records: list[dict[str, Any]] = []
    all_stress_records: list[dict[str, Any]] = []
    dataset_identity = {item["datasetId"]: item for item in development["datasetMatrix"]}
    for strategy in strategies:
        fold_diagnostics = []
        strategy_test_records: list[dict[str, Any]] = []
        strategy_stress_records: list[dict[str, Any]] = []
        for fold in strategy["folds"]:
            train = _selected_train_aggregate(fold)
            validation = fold["validation"]["aggregate"]
            test = fold["test"]["aggregate"]
            stress = fold["stressTest"]["aggregate"]
            flags = []
            if train["medianNetReturn"] <= 0:
                flags.append("SELECTED_TRAIN_MEDIAN_NON_POSITIVE")
            if validation["medianNetReturn"] <= 0:
                flags.append("VALIDATION_MEDIAN_NON_POSITIVE")
            if test["medianNetReturn"] <= 0:
                flags.append("TEST_MEDIAN_NON_POSITIVE")
            if test["positiveDatasetFraction"] < minimum_fraction:
                flags.append("TEST_CROSS_MARKET_INCONSISTENT")
            if stress["medianNetReturn"] < stress_floor:
                flags.append("HIGH_COST_TEST_BELOW_THRESHOLD")
            if test["maxDrawdown"] > drawdown_limit:
                flags.append("TEST_DRAWDOWN_ABOVE_PROMOTION_LIMIT")
            if fold["parameterStability"]["passed"] is not True:
                flags.append("PARAMETER_PERTURBATION_UNSTABLE")
            for record in fold["test"]["perDataset"]:
                enriched = {**record, "fold": fold["fold"], "strategyId": strategy["strategyId"]}
                strategy_test_records.append(enriched)
                all_test_records.append(enriched)
            for record in fold["stressTest"]["perDataset"]:
                enriched = {**record, "fold": fold["fold"], "strategyId": strategy["strategyId"]}
                strategy_stress_records.append(enriched)
                all_stress_records.append(enriched)
            fold_diagnostics.append({
                "fold": fold["fold"],
                "selectedTrain": train,
                "validation": validation,
                "test": test,
                "highCostStress": stress,
                "parameterStability": fold["parameterStability"],
                "observedFailureSignals": flags,
            })
        diagnostics.append({
            "strategyId": strategy["strategyId"],
            "specId": strategy["specId"],
            "semanticFingerprint": strategy_semantic_fingerprint(specs[strategy["strategyId"]]),
            "selectionCount": strategy["selectionCountTotal"],
            "folds": fold_diagnostics,
            "developmentTestSummary": _development_slice_summary(strategy_test_records),
            "highCostStressSummary": _development_slice_summary(strategy_stress_records),
            "costDegradationMean": (
                _development_slice_summary(strategy_test_records)["meanNetReturn"]
                - _development_slice_summary(strategy_stress_records)["meanNetReturn"]
            ),
            "parameterSensitivity": {
                "stableFoldCount": sum(item["parameterStability"]["passed"] is True for item in strategy["folds"]),
                "foldCount": len(strategy["folds"]),
                "maxMedianReturnDelta": max(float(item["parameterStability"]["maxMedianReturnDelta"]) for item in strategy["folds"]),
            },
            "observedFailureSignals": sorted({flag for fold in fold_diagnostics for flag in fold["observedFailureSignals"]}),
            "causalClaim": False,
            "holdoutMetricsUsed": False,
        })

    market_analysis = []
    for dataset_id in sorted(dataset_identity):
        identity = dataset_identity[dataset_id]
        test_records = [item for item in all_test_records if item["datasetId"] == dataset_id]
        stress_records = [item for item in all_stress_records if item["datasetId"] == dataset_id]
        market_analysis.append({
            "datasetId": dataset_id,
            "symbol": identity["symbol"],
            "timeframe": identity["timeframe"],
            "test": _development_slice_summary(test_records),
            "highCostStress": _development_slice_summary(stress_records),
            "costDegradationMean": _development_slice_summary(test_records)["meanNetReturn"] - _development_slice_summary(stress_records)["meanNetReturn"],
        })
    timeframe_analysis = []
    for timeframe in sorted({item["timeframe"] for item in dataset_identity.values()}):
        ids = {key for key, item in dataset_identity.items() if item["timeframe"] == timeframe}
        test_records = [item for item in all_test_records if item["datasetId"] in ids]
        stress_records = [item for item in all_stress_records if item["datasetId"] in ids]
        timeframe_analysis.append({
            "timeframe": timeframe,
            "datasetCount": len(ids),
            "test": _development_slice_summary(test_records),
            "highCostStress": _development_slice_summary(stress_records),
            "costDegradationMean": _development_slice_summary(test_records)["meanNetReturn"] - _development_slice_summary(stress_records)["meanNetReturn"],
        })

    report: dict[str, Any] = {
        "schemaVersion": "stage-4a13.failure-attribution.v1",
        "labels": ATTRIBUTION_LABELS,
        "baselineCommit": baseline_commit,
        "engineCommit": development["sourceCommit"],
        "candidateManifestId": candidate_manifest["manifestId"],
        "developmentId": development["developmentId"],
        "researchEvidenceCutoff": "END_OF_STAGE_4A12_DEVELOPMENT_WINDOWS",
        "finalHoldoutUsedForAttribution": False,
        "finalHoldoutUsedForDesign": False,
        "diagnostics": diagnostics,
        "marketAnalysis": market_analysis,
        "timeframeAnalysis": timeframe_analysis,
        "reportingPolicy": "all candidates, markets, timeframes, and folds are reported; winner-only filtering is prohibited",
        "gateGapAudit": [
            {
                "code": "LAST_FOLD_ONLY_PREHOLDOUT_DECISION",
                "evidence": "cost and cross-market preholdout checks read only the final development fold",
                "requiredCorrection": "future gates aggregate every development fold before opening fresh evidence",
            },
            {
                "code": "FAMILY_WIDE_SELECTION_COUNT_MISSING",
                "evidence": "selection counts are recorded per strategy, not across the candidate family",
                "requiredCorrection": "future gates bind family-wide candidate and parameter comparison counts",
            },
            {
                "code": "PREHOLDOUT_REJECTED_CANDIDATES_CONSUMED_HOLDOUT",
                "evidence": "the finalizer evaluated every candidate, including candidates already rejected before holdout",
                "requiredCorrection": "fresh evidence may be opened only for pre-registered, preholdout-eligible frozen lineages",
            },
            {
                "code": "NEGATIVE_TRAIN_WINNER_NOT_REJECTED",
                "evidence": "train ranking selects the least-bad parameter set even when every train candidate is non-positive",
                "requiredCorrection": "future gates require an absolute development threshold before ranking can advance",
            },
        ],
        "researchHypotheses": [
            "require absolute development viability before relative candidate ranking",
            "aggregate cross-market, cost, drawdown, and stability evidence across all development folds",
            "charge selection-bias controls across the full frozen candidate family",
            "open fresh evidence only after lineage, semantics, parameters, and costs are frozen",
        ],
        "strategyRuleChanges": [],
        "parameterChanges": [],
        "marketOrTimeframeSelectionChanges": [],
        "approvals": {"paperApproved": False, "testnetApproved": False, "liveApproved": False},
    }
    report["reportId"] = canonical_sha256(report)
    return report


def verify_failure_attribution(report: Mapping[str, Any], candidate_manifest: Mapping[str, Any]) -> None:
    if report.get("schemaVersion") != "stage-4a13.failure-attribution.v1" or report.get("labels") != ATTRIBUTION_LABELS:
        raise ValueError("ATTRIBUTION_REPORT_CONTRACT_INVALID")
    _verify_self_digest(report, "reportId", "ATTRIBUTION_REPORT_ID_INVALID")
    _verify_self_digest(candidate_manifest, "manifestId", "ATTRIBUTION_MANIFEST_ID_INVALID")
    if report.get("candidateManifestId") != candidate_manifest.get("manifestId"):
        raise ValueError("ATTRIBUTION_REPORT_MANIFEST_MISMATCH")
    if report.get("finalHoldoutUsedForAttribution") is not False or report.get("finalHoldoutUsedForDesign") is not False:
        raise ValueError("ATTRIBUTION_REPORT_HOLDOUT_CONTAMINATED")
    if report.get("strategyRuleChanges") != [] or report.get("parameterChanges") != [] or report.get("marketOrTimeframeSelectionChanges") != []:
        raise ValueError("ATTRIBUTION_REPORT_DESIGN_CHANGE_DETECTED")
    diagnostics = report.get("diagnostics")
    if not isinstance(diagnostics, list) or len(diagnostics) != candidate_manifest.get("candidateCount"):
        raise ValueError("ATTRIBUTION_REPORT_DIAGNOSTICS_INVALID")
    specs = {item["strategyId"]: item for item in candidate_manifest["specs"]}
    for diagnostic in diagnostics:
        spec = specs.get(diagnostic.get("strategyId"))
        if not spec or diagnostic.get("specId") != spec.get("specId"):
            raise ValueError("ATTRIBUTION_REPORT_SPEC_MISMATCH")
        if diagnostic.get("semanticFingerprint") != strategy_semantic_fingerprint(spec):
            raise ValueError("ATTRIBUTION_REPORT_SEMANTICS_MISMATCH")
        if diagnostic.get("holdoutMetricsUsed") is not False or diagnostic.get("causalClaim") is not False:
            raise ValueError("ATTRIBUTION_REPORT_CLAIM_INVALID")
    if report.get("approvals") != {"paperApproved": False, "testnetApproved": False, "liveApproved": False}:
        raise ValueError("ATTRIBUTION_REPORT_APPROVAL_INVALID")


def fresh_window_id(window: Mapping[str, Any]) -> str:
    identity_fields = (
        "datasetId",
        "predecessorWindowId",
        "symbol",
        "timeframe",
        "opensAt",
        "closesAt",
        "gapPolicy",
        "segmentPolicy",
    )
    return canonical_sha256({key: window.get(key) for key in identity_fields})


def evidence_window_fingerprint(window: Mapping[str, Any]) -> str:
    return canonical_sha256({
        "opensAt": window.get("opensAt"),
        "closesAt": window.get("closesAt"),
        "windowDataSha256": window.get("windowDataSha256"),
    })


def verify_fresh_window(window: Mapping[str, Any], *, require_sealed: bool = True) -> None:
    if window.get("schemaVersion") != "stage-4a13.fresh-evidence-window.v1":
        raise ValueError("FRESH_EVIDENCE_WINDOW_SCHEMA_INVALID")
    if window.get("timeframe") not in {"5m", "4h", "1h"}:
        raise ValueError("FRESH_EVIDENCE_TIMEFRAME_INVALID")
    if window.get("timeframe") == "1h" and window.get("segmentPolicy") != "explicit-no-cross-gap":
        raise ValueError("FRESH_EVIDENCE_1H_SEGMENT_POLICY_REQUIRED")
    if window.get("gapPolicy") not in {"reject", "segment"}:
        raise ValueError("FRESH_EVIDENCE_GAP_POLICY_INVALID")
    if window.get("status") not in {"PLANNED", "SEALED"}:
        raise ValueError("FRESH_EVIDENCE_STATUS_INVALID")
    if _parse_timestamp(str(window.get("opensAt"))) >= _parse_timestamp(str(window.get("closesAt"))):
        raise ValueError("FRESH_EVIDENCE_RANGE_INVALID")
    if window.get("windowId") != fresh_window_id(window):
        raise ValueError("FRESH_EVIDENCE_WINDOW_ID_INVALID")
    if window.get("status") == "PLANNED":
        if any(window.get(key) is not None for key in ("sourceDataframeSha256", "windowDataSha256", "evidenceFingerprint", "startRow", "endRowExclusive")):
            raise ValueError("FRESH_EVIDENCE_PLAN_CONTAINS_DATA")
    else:
        if window.get("status") != "SEALED" or not SHA256_PATTERN.fullmatch(str(window.get("sourceDataframeSha256", ""))):
            raise ValueError("FRESH_EVIDENCE_WINDOW_NOT_SEALED")
        if not SHA256_PATTERN.fullmatch(str(window.get("windowDataSha256", ""))) or window.get("evidenceFingerprint") != evidence_window_fingerprint(window):
            raise ValueError("FRESH_EVIDENCE_FINGERPRINT_INVALID")
        if not isinstance(window.get("startRow"), int) or not isinstance(window.get("endRowExclusive"), int) or window["startRow"] >= window["endRowExclusive"]:
            raise ValueError("FRESH_EVIDENCE_ROWS_INVALID")
    if require_sealed and window.get("status") != "SEALED":
        raise ValueError("FRESH_EVIDENCE_WINDOW_NOT_SEALED")


def verify_strategy_lineage(
    lineage: Mapping[str, Any],
    spec: Mapping[str, Any],
    consumed_window_ids: Sequence[str],
    fresh_window: Mapping[str, Any],
    parent: Mapping[str, Any] | None = None,
) -> None:
    required = {
        "strategyId", "specId", "parentStrategyId", "parentSpecId", "researchEvidenceCutoff",
        "designEvidenceWindowIds", "consumedHoldoutWindowIds", "designInputs", "freezeCommit",
        "freezeTimestamp", "freshEvidenceWindowId", "semanticFingerprint", "lineageRootId", "lineageId",
    }
    if not required.issubset(lineage):
        raise ValueError("STRATEGY_LINEAGE_FIELDS_MISSING")
    if lineage["strategyId"] != spec.get("strategyId") or lineage["specId"] != spec.get("specId"):
        raise ValueError("STRATEGY_LINEAGE_SPEC_MISMATCH")
    if lineage["semanticFingerprint"] != strategy_semantic_fingerprint(spec):
        raise ValueError("STRATEGY_LINEAGE_SEMANTICS_MISMATCH")
    if not COMMIT_PATTERN.fullmatch(str(lineage["freezeCommit"])):
        raise ValueError("STRATEGY_FREEZE_COMMIT_INVALID")
    verify_fresh_window(fresh_window, require_sealed=False)
    if lineage["freshEvidenceWindowId"] != fresh_window["windowId"]:
        raise ValueError("STRATEGY_FRESH_WINDOW_MISMATCH")
    cutoff = _parse_timestamp(str(lineage["researchEvidenceCutoff"]))
    frozen = _parse_timestamp(str(lineage["freezeTimestamp"]))
    opens = _parse_timestamp(str(fresh_window["opensAt"]))
    if cutoff > frozen or frozen >= opens:
        raise ValueError("STRATEGY_FREEZE_ORDER_INVALID")
    consumed = set(consumed_window_ids)
    declared_consumed = set(lineage["consumedHoldoutWindowIds"])
    if not consumed.issubset(declared_consumed):
        raise ValueError("STRATEGY_CONSUMED_EVIDENCE_OMITTED")
    if declared_consumed.intersection(lineage["designEvidenceWindowIds"]):
        raise ValueError("STRATEGY_DESIGN_USES_CONSUMED_HOLDOUT")
    if lineage["freshEvidenceWindowId"] in declared_consumed or lineage["freshEvidenceWindowId"] in lineage["designEvidenceWindowIds"]:
        raise ValueError("STRATEGY_FRESH_WINDOW_CONTAMINATED")
    if not lineage["designInputs"] or any(not SHA256_PATTERN.fullmatch(str(item)) for item in lineage["designInputs"]):
        raise ValueError("STRATEGY_DESIGN_INPUTS_INVALID")
    if any(not SHA256_PATTERN.fullmatch(str(item)) for item in lineage["designEvidenceWindowIds"] + lineage["consumedHoldoutWindowIds"]):
        raise ValueError("STRATEGY_EVIDENCE_WINDOW_ID_INVALID")
    if parent is not None:
        if lineage["parentStrategyId"] != parent["strategyId"] or lineage["parentSpecId"] != parent["specId"]:
            raise ValueError("STRATEGY_PARENT_MISMATCH")
        if lineage["lineageRootId"] != parent["lineageRootId"]:
            raise ValueError("STRATEGY_LINEAGE_ROOT_RESET")
        if not set(parent["consumedHoldoutWindowIds"]).issubset(declared_consumed):
            raise ValueError("STRATEGY_PARENT_EVIDENCE_OMITTED")
    else:
        if lineage["parentStrategyId"] is not None or lineage["parentSpecId"] is not None:
            raise ValueError("STRATEGY_ROOT_HAS_PARENT")
        expected_root = canonical_sha256({"semanticFingerprint": lineage["semanticFingerprint"]})
        if lineage["lineageRootId"] != expected_root:
            raise ValueError("STRATEGY_LINEAGE_ROOT_INVALID")
    unsigned = dict(lineage)
    lineage_id = unsigned.pop("lineageId")
    if lineage_id != canonical_sha256(unsigned):
        raise ValueError("STRATEGY_LINEAGE_ID_INVALID")


def build_consumed_evidence_seed(
    final_report: Mapping[str, Any],
    legacy_ledger: Mapping[str, Any],
    promotion_receipt: Mapping[str, Any],
    candidate_manifest: Mapping[str, Any],
    window_boundaries: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    """Convert the 4A12 private ledger into a source-free, immutable seed."""
    verify_promotion_receipt(promotion_receipt, candidate_manifest)
    _verify_self_digest(final_report, "proofId", "EVIDENCE_FINAL_PROOF_ID_INVALID")
    if final_report["proofId"] != promotion_receipt["privateProofId"]:
        raise ValueError("EVIDENCE_FINAL_RECEIPT_MISMATCH")
    if legacy_ledger.get("schemaVersion") != "stage-4a12.holdout-ledger.v1":
        raise ValueError("EVIDENCE_LEGACY_LEDGER_INVALID")
    legacy_entries = legacy_ledger.get("entries", {})
    specs = {item["strategyId"]: item for item in candidate_manifest["specs"]}
    windows: dict[str, Any] = {}
    evaluations: dict[str, Any] = {}
    for decision in final_report["decisions"]:
        strategy_id = decision["strategyId"]
        for result in decision["finalHoldout"]["perDataset"]:
            ledger_key = result["ledgerKey"]
            legacy = legacy_entries.get(ledger_key)
            if not legacy or legacy.get("status") != "consumed" or legacy.get("evaluationCount") != 1:
                raise ValueError("EVIDENCE_LEGACY_ENTRY_NOT_CONSUMED")
            result_without_binding = {key: value for key, value in result.items() if key not in {"datasetId", "ledgerKey"}}
            if legacy.get("resultDigest") != canonical_sha256(result_without_binding):
                raise ValueError("EVIDENCE_LEGACY_RESULT_DIGEST_MISMATCH")
            window_payload = {
                "datasetMatrixId": final_report["datasetMatrixId"],
                "datasetId": result["datasetId"],
                "start": result["start"],
                "endExclusive": result["endExclusive"],
            }
            boundary = window_boundaries.get(result["datasetId"])
            if not boundary or boundary.get("start") != result["start"] or boundary.get("endExclusive") != result["endExclusive"]:
                raise ValueError("EVIDENCE_WINDOW_BOUNDARY_MISMATCH")
            for key in ("opensAt", "closesAt", "windowDataSha256"):
                if not boundary.get(key):
                    raise ValueError("EVIDENCE_WINDOW_BOUNDARY_INCOMPLETE")
            window_id = canonical_sha256(window_payload)
            evidence_fingerprint = evidence_window_fingerprint({"datasetId": result["datasetId"], **boundary})
            windows.setdefault(window_id, {
                **window_payload,
                "windowId": window_id,
                "opensAt": boundary["opensAt"],
                "closesAt": boundary["closesAt"],
                "windowDataSha256": boundary["windowDataSha256"],
                "evidenceFingerprint": evidence_fingerprint,
                "state": "CONSUMED",
            })
            semantic_fingerprint = strategy_semantic_fingerprint(specs[strategy_id])
            evaluation_id = canonical_sha256({"semanticFingerprint": semantic_fingerprint, "evidenceFingerprint": evidence_fingerprint})
            evaluations[evaluation_id] = {
                "evaluationId": evaluation_id,
                "sourceEvaluationId": ledger_key,
                "windowId": window_id,
                "evidenceFingerprint": evidence_fingerprint,
                "datasetId": result["datasetId"],
                "opensAt": boundary["opensAt"],
                "closesAt": boundary["closesAt"],
                "strategyId": strategy_id,
                "specId": decision["specId"],
                "semanticFingerprint": semantic_fingerprint,
                "runId": legacy["runId"],
                "evaluationCount": 1,
                "state": "CONSUMED",
                "resultDigest": legacy["resultDigest"],
            }
    if len(evaluations) != 40 or len(windows) != 10 or {item["sourceEvaluationId"] for item in evaluations.values()} != set(legacy_entries):
        raise ValueError("EVIDENCE_SEED_CARDINALITY_INVALID")
    seed: dict[str, Any] = {
        "schemaVersion": "stage-4a13.consumed-evidence-seed.v1",
        "labels": LEDGER_LABELS,
        "sourceProofId": final_report["proofId"],
        "sourceReceiptId": promotion_receipt["receiptId"],
        "holdoutRunId": final_report["holdoutRunId"],
        "windowCount": len(windows),
        "evaluationCount": len(evaluations),
        "windows": sorted(windows.values(), key=lambda item: item["windowId"]),
        "evaluations": sorted(evaluations.values(), key=lambda item: item["evaluationId"]),
        "approvals": {"paperApproved": False, "testnetApproved": False, "liveApproved": False},
    }
    seed["seedId"] = canonical_sha256(seed)
    return seed


def verify_consumed_evidence_seed(
    seed: Mapping[str, Any],
    promotion_receipt: Mapping[str, Any],
    candidate_manifest: Mapping[str, Any],
) -> None:
    verify_promotion_receipt(promotion_receipt, candidate_manifest)
    if seed.get("schemaVersion") != "stage-4a13.consumed-evidence-seed.v1" or seed.get("labels") != LEDGER_LABELS:
        raise ValueError("EVIDENCE_SEED_CONTRACT_INVALID")
    _verify_self_digest(seed, "seedId", "EVIDENCE_SEED_ID_INVALID")
    if seed.get("sourceProofId") != promotion_receipt.get("privateProofId") or seed.get("sourceReceiptId") != promotion_receipt.get("receiptId"):
        raise ValueError("EVIDENCE_SEED_SOURCE_MISMATCH")
    if seed.get("holdoutRunId") != promotion_receipt.get("holdoutRunId"):
        raise ValueError("EVIDENCE_SEED_RUN_MISMATCH")
    windows = seed.get("windows")
    evaluations = seed.get("evaluations")
    if not isinstance(windows, list) or not isinstance(evaluations, list) or len(windows) != 10 or len(evaluations) != 40:
        raise ValueError("EVIDENCE_SEED_CARDINALITY_INVALID")
    if seed.get("windowCount") != 10 or seed.get("evaluationCount") != 40:
        raise ValueError("EVIDENCE_SEED_DECLARED_COUNT_INVALID")
    window_ids = {item.get("windowId") for item in windows}
    if len(window_ids) != 10 or any(item.get("state") != "CONSUMED" for item in windows):
        raise ValueError("EVIDENCE_SEED_WINDOWS_INVALID")
    specs = {item["strategyId"]: item for item in candidate_manifest["specs"]}
    evaluation_ids = set()
    source_ids = set()
    for evaluation in evaluations:
        evaluation_ids.add(evaluation.get("evaluationId"))
        source_ids.add(evaluation.get("sourceEvaluationId"))
        spec = specs.get(evaluation.get("strategyId"))
        if not spec or evaluation.get("specId") != spec.get("specId"):
            raise ValueError("EVIDENCE_SEED_SPEC_INVALID")
        fingerprint = strategy_semantic_fingerprint(spec)
        if evaluation.get("semanticFingerprint") != fingerprint:
            raise ValueError("EVIDENCE_SEED_SEMANTICS_INVALID")
        window = next((item for item in windows if item.get("windowId") == evaluation.get("windowId")), None)
        expected_id = canonical_sha256({"semanticFingerprint": fingerprint, "evidenceFingerprint": evaluation.get("evidenceFingerprint")})
        if (
            not window
            or evaluation.get("evidenceFingerprint") != window.get("evidenceFingerprint")
            or evaluation.get("datasetId") != window.get("datasetId")
            or evaluation.get("opensAt") != window.get("opensAt")
            or evaluation.get("closesAt") != window.get("closesAt")
            or evaluation.get("evaluationId") != expected_id
            or evaluation.get("windowId") not in window_ids
        ):
            raise ValueError("EVIDENCE_SEED_EVALUATION_ID_INVALID")
        if evaluation.get("state") != "CONSUMED" or evaluation.get("evaluationCount") != 1:
            raise ValueError("EVIDENCE_SEED_STATE_INVALID")
    if len(evaluation_ids) != 40 or len(source_ids) != 40:
        raise ValueError("EVIDENCE_SEED_DUPLICATE_INVALID")
    if seed.get("approvals") != {"paperApproved": False, "testnetApproved": False, "liveApproved": False}:
        raise ValueError("EVIDENCE_SEED_APPROVAL_INVALID")


def build_governance_contract(baseline_commit: str) -> dict[str, Any]:
    if not COMMIT_PATTERN.fullmatch(baseline_commit):
        raise ValueError("GOVERNANCE_BASELINE_COMMIT_INVALID")
    contract: dict[str, Any] = {
        "schemaVersion": "stage-4a13.governance-contract.v1",
        "baselineCommit": baseline_commit,
        "terminalBoundary": "STAGE 4A13 IS THE FINAL STAGE 4A FUNCTIONAL STAGE",
        "requiredLineageFields": [
            "strategyId", "specId", "parentStrategyId", "parentSpecId", "researchEvidenceCutoff",
            "designEvidenceWindowIds", "consumedHoldoutWindowIds", "designInputs", "freezeCommit",
            "freezeTimestamp", "freshEvidenceWindowId", "semanticFingerprint", "lineageRootId", "lineageId",
        ],
        "semanticFingerprintExcludes": [
            "strategyId", "specId", "version", "label", "parentStrategyId", "parentSpecId", "lineage",
        ],
        "specFreezeOrder": [
            "development-only research cutoff sealed",
            "strategy semantics, parameters, costs, symbols, and timeframes frozen",
            "lineage and consumed windows inherited",
            "freeze commit and UTC timestamp recorded",
            "fresh evidence window opens strictly after freeze timestamp",
        ],
        "freshEvidenceWindowSchema": {
            "schemaVersion": "stage-4a13.fresh-evidence-window.v1",
            "requiredFields": [
                "windowId", "datasetId", "predecessorWindowId", "symbol", "timeframe", "opensAt", "closesAt",
                "gapPolicy", "segmentPolicy", "sourceDataframeSha256", "startRow", "endRowExclusive", "status",
            ],
            "usableStatus": "SEALED",
            "oneHourPolicy": "explicit-no-cross-gap",
            "noGapFilling": True,
        },
        "evidenceLedgerContract": {
            "schemaVersion": "stage-4a13.evidence-ledger.v1",
            "appendOnlyEvents": True,
            "reservationIsConsumption": True,
            "familyReservation": "all pre-frozen semantic families are reserved atomically before any evaluation",
            "evaluationIdentity": "sha256(semanticFingerprint + evidenceFingerprint)",
            "identityChangeResetsConsumption": False,
            "completionRetryAllowed": False,
        },
        "freshPromotionProofRequirements": [
            "spec and parameters frozen before the evidence window opens",
            "window is chronologically later than every inherited consumed holdout window",
            "window was not used for development, attribution, ranking, market selection, or parameter selection",
            "each semantic strategy family and evidence window pair is evaluated at most once",
            "all events are persisted in the append-only evidence ledger",
            "insufficient new evidence yields readiness only and no promotion proof",
        ],
        "nextGenerationFrozenSpecCount": 0,
        "freshEvidenceWindowAvailable": False,
        "freshPromotionProofAllowed": False,
        "paperApproved": False,
        "testnetApproved": False,
        "liveApproved": False,
    }
    contract["contractId"] = canonical_sha256(contract)
    return contract


def verify_governance_contract(contract: Mapping[str, Any]) -> None:
    if contract.get("schemaVersion") != "stage-4a13.governance-contract.v1":
        raise ValueError("GOVERNANCE_CONTRACT_SCHEMA_INVALID")
    _verify_self_digest(contract, "contractId", "GOVERNANCE_CONTRACT_ID_INVALID")
    if contract.get("nextGenerationFrozenSpecCount") != 0 or contract.get("freshEvidenceWindowAvailable") is not False:
        raise ValueError("GOVERNANCE_CONTRACT_FRESH_EVIDENCE_CLAIM_INVALID")
    if any(contract.get(key) is not False for key in ("freshPromotionProofAllowed", "paperApproved", "testnetApproved", "liveApproved")):
        raise ValueError("GOVERNANCE_CONTRACT_APPROVAL_INVALID")


def build_governance_attestation_subject(
    report: Mapping[str, Any],
    seed: Mapping[str, Any],
    contract: Mapping[str, Any],
    receipt_commit: str,
) -> dict[str, Any]:
    if not COMMIT_PATTERN.fullmatch(receipt_commit):
        raise ValueError("GOVERNANCE_ATTESTATION_COMMIT_INVALID")
    subject: dict[str, Any] = {
        "schemaVersion": "stage-4a13.attested-governance.v1",
        "labels": ATTRIBUTION_LABELS,
        "receiptCommit": receipt_commit,
        "failureAttributionReportId": report["reportId"],
        "consumedEvidenceSeedId": seed["seedId"],
        "governanceContractId": contract["contractId"],
        "freshEvidenceWindowAvailable": False,
        "paperApproved": False,
        "testnetApproved": False,
        "liveApproved": False,
    }
    subject["subjectId"] = canonical_sha256(subject)
    return subject


class EvidenceLedger:
    """Append-only event ledger keyed by semantic fingerprint plus window ID."""

    def __init__(self, path: Path):
        self.path = path

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            payload: dict[str, Any] = {"schemaVersion": "stage-4a13.evidence-ledger.v1", "labels": LEDGER_LABELS, "events": []}
            payload["ledgerId"] = canonical_sha256(payload)
            return payload
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        if payload.get("schemaVersion") != "stage-4a13.evidence-ledger.v1" or payload.get("labels") != LEDGER_LABELS:
            raise ValueError("EVIDENCE_LEDGER_SCHEMA_INVALID")
        _verify_self_digest(payload, "ledgerId", "EVIDENCE_LEDGER_ID_INVALID")
        self._state(payload["events"])
        return payload

    @staticmethod
    def _state(events: Sequence[Mapping[str, Any]]) -> dict[str, Mapping[str, Any]]:
        state: dict[str, Mapping[str, Any]] = {}
        for index, event in enumerate(events):
            if event.get("sequence") != index + 1:
                raise ValueError("EVIDENCE_LEDGER_SEQUENCE_INVALID")
            evaluation_id = str(event.get("evaluationId", ""))
            event_type = event.get("eventType")
            if event_type in {"IMPORTED_CONSUMED", "RESERVED"}:
                if evaluation_id in state:
                    raise ValueError("EVIDENCE_LEDGER_DUPLICATE_EVALUATION")
                expected_id = canonical_sha256({
                    "semanticFingerprint": event.get("semanticFingerprint"),
                    "evidenceFingerprint": event.get("evidenceFingerprint"),
                })
                if evaluation_id != expected_id or event.get("evaluationCount") != 1:
                    raise ValueError("EVIDENCE_LEDGER_EVALUATION_ID_INVALID")
                state[evaluation_id] = event
            elif event_type == "CONSUMED":
                prior = state.get(evaluation_id)
                if not prior or prior.get("eventType") != "RESERVED":
                    raise ValueError("EVIDENCE_LEDGER_TRANSITION_INVALID")
                for key in ("semanticFingerprint", "evidenceFingerprint", "windowId", "datasetId", "strategyId", "specId"):
                    if event.get(key) != prior.get(key):
                        raise ValueError("EVIDENCE_LEDGER_TRANSITION_IDENTITY_CHANGED")
                if event.get("evaluationCount") != 1 or not SHA256_PATTERN.fullmatch(str(event.get("resultDigest", ""))):
                    raise ValueError("EVIDENCE_LEDGER_RESULT_INVALID")
                state[evaluation_id] = event
            else:
                raise ValueError("EVIDENCE_LEDGER_EVENT_INVALID")
        return state

    def _write(self, payload: Mapping[str, Any]) -> None:
        unsigned = dict(payload)
        unsigned.pop("ledgerId", None)
        unsigned["ledgerId"] = canonical_sha256(unsigned)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f"{self.path.name}.{uuid.uuid4().hex}.tmp")
        temporary.write_text(json.dumps(unsigned, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(temporary, self.path)

    def import_seed(self, seed: Mapping[str, Any]) -> None:
        _verify_self_digest(seed, "seedId", "EVIDENCE_SEED_ID_INVALID")
        if seed.get("schemaVersion") != "stage-4a13.consumed-evidence-seed.v1" or seed.get("labels") != LEDGER_LABELS:
            raise ValueError("EVIDENCE_SEED_CONTRACT_INVALID")
        if seed.get("windowCount") != 10 or seed.get("evaluationCount") != 40 or len(seed.get("windows", [])) != 10 or len(seed.get("evaluations", [])) != 40:
            raise ValueError("EVIDENCE_SEED_CARDINALITY_INVALID")
        payload = self._load()
        if payload["events"]:
            raise ValueError("EVIDENCE_LEDGER_ALREADY_INITIALIZED")
        for evaluation in seed["evaluations"]:
            payload["events"].append({
                "sequence": len(payload["events"]) + 1,
                "eventType": "IMPORTED_CONSUMED",
                **evaluation,
            })
        self._write(payload)

    def reserve_batch(self, identities: Sequence[Mapping[str, str]], window: Mapping[str, Any]) -> list[str]:
        verify_fresh_window(window)
        if not identities:
            raise ValueError("EVIDENCE_RESERVATION_BATCH_EMPTY")
        for identity in identities:
            if not SHA256_PATTERN.fullmatch(str(identity.get("semanticFingerprint", ""))) or not SHA256_PATTERN.fullmatch(str(identity.get("specId", ""))) or not identity.get("strategyId"):
                raise ValueError("EVIDENCE_RESERVATION_IDENTITY_INVALID")
        payload = self._load()
        state = self._state(payload["events"])
        evidence_fingerprint = window["evidenceFingerprint"]
        if any(event.get("evidenceFingerprint") == evidence_fingerprint for event in payload["events"]):
            raise ValueError("CONSUMED_EVIDENCE_WINDOW_REUSE_DETECTED")
        evaluation_ids = [
            canonical_sha256({"semanticFingerprint": identity["semanticFingerprint"], "evidenceFingerprint": evidence_fingerprint})
            for identity in identities
        ]
        if len(set(evaluation_ids)) != len(evaluation_ids) or any(item in state for item in evaluation_ids):
            raise ValueError("CONSUMED_EVIDENCE_REUSE_DETECTED")
        opens = _parse_timestamp(str(window["opensAt"]))
        prior_closes = [
            _parse_timestamp(str(event["closesAt"]))
            for event in payload["events"]
            if event.get("datasetId") == window.get("datasetId") and event.get("closesAt")
        ]
        if prior_closes and opens < max(prior_closes):
            raise ValueError("EVIDENCE_WINDOW_NOT_CHRONOLOGICALLY_FRESH")
        for identity, evaluation_id in zip(identities, evaluation_ids, strict=True):
            payload["events"].append({
                "sequence": len(payload["events"]) + 1,
                "eventType": "RESERVED",
                "evaluationId": evaluation_id,
                "semanticFingerprint": identity["semanticFingerprint"],
                "windowId": window["windowId"],
                "evidenceFingerprint": evidence_fingerprint,
                "datasetId": window["datasetId"],
                "opensAt": window["opensAt"],
                "closesAt": window["closesAt"],
                "strategyId": identity["strategyId"],
                "specId": identity["specId"],
                "evaluationCount": 1,
            })
        self._write(payload)
        return evaluation_ids

    def reserve(self, semantic_fingerprint: str, window: Mapping[str, Any], strategy_id: str, spec_id: str) -> str:
        return self.reserve_batch([{
            "semanticFingerprint": semantic_fingerprint,
            "strategyId": strategy_id,
            "specId": spec_id,
        }], window)[0]

    def complete(self, evaluation_id: str, result_digest: str) -> None:
        if not SHA256_PATTERN.fullmatch(result_digest):
            raise ValueError("EVIDENCE_RESULT_DIGEST_INVALID")
        payload = self._load()
        state = self._state(payload["events"])
        prior = state.get(evaluation_id)
        if not prior or prior.get("eventType") != "RESERVED":
            raise ValueError("EVIDENCE_RESERVATION_NOT_OPEN")
        payload["events"].append({
            "sequence": len(payload["events"]) + 1,
            "eventType": "CONSUMED",
            "evaluationId": evaluation_id,
            "semanticFingerprint": prior["semanticFingerprint"],
            "windowId": prior["windowId"],
            "evidenceFingerprint": prior["evidenceFingerprint"],
            "datasetId": prior["datasetId"],
            "opensAt": prior["opensAt"],
            "closesAt": prior["closesAt"],
            "strategyId": prior["strategyId"],
            "specId": prior["specId"],
            "evaluationCount": 1,
            "resultDigest": result_digest,
        })
        self._write(payload)
