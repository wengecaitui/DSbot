"""Source-free Stage 4A12 promotion decision receipt."""

from __future__ import annotations

import json
import re
from typing import Any, Mapping

from .strategy_spec import canonical_sha256


RECEIPT_LABELS = [
    "PUBLIC DIGEST RECEIPT ONLY",
    "PRIVATE FULL ROBUSTNESS PROOF REQUIRED",
    "PAPER READINESS REVIEW ONLY",
    "NOT APPROVED FOR PAPER, TESTNET OR LIVE",
]
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")


def build_promotion_receipt(
    development: Mapping[str, Any],
    final: Mapping[str, Any],
    candidate_manifest: Mapping[str, Any],
    engine_commit: str,
) -> dict[str, Any]:
    if final.get("developmentId") != development.get("developmentId"):
        raise ValueError("PROMOTION_RECEIPT_DEVELOPMENT_MISMATCH")
    if final.get("datasetMatrixId") != development.get("datasetMatrixId"):
        raise ValueError("PROMOTION_RECEIPT_DATASET_MISMATCH")
    if final.get("sourceCommit") != engine_commit or development.get("sourceCommit") != engine_commit:
        raise ValueError("PROMOTION_RECEIPT_ENGINE_COMMIT_MISMATCH")
    strategy_development = {item["strategyId"]: item for item in development["strategies"]}
    decisions = []
    for decision in final["decisions"]:
        dev = strategy_development[decision["strategyId"]]
        last = dev["folds"][-1]
        decisions.append({
            "strategyId": decision["strategyId"],
            "specId": decision["specId"],
            "deploymentParameterId": decision["deploymentParameterId"],
            "selectionCount": dev["selectionCountTotal"],
            "validationAndTestUsedForFitting": False,
            "lastFoldTest": last["test"]["aggregate"],
            "lastFoldHighCostStress": last["stressTest"]["aggregate"],
            "parameterStability": last["parameterStability"],
            "finalHoldoutEvaluationCount": decision["finalHoldoutEvaluationCount"],
            "finalHoldout": decision["finalHoldout"]["aggregate"],
            "robustnessPassed": decision["robustnessPassed"],
            "promotionEligible": decision["promotionEligible"],
            "promotionReasons": list(decision["promotionReasons"]),
            "paperReadinessReview": decision["paperReadinessReview"],
            "paperApproved": False,
            "testnetApproved": False,
            "liveApproved": False,
        })
    receipt: dict[str, Any] = {
        "schemaVersion": "stage-4a12.public-promotion-decision.v1",
        "labels": RECEIPT_LABELS,
        "engineCommit": engine_commit,
        "candidateManifestId": candidate_manifest["manifestId"],
        "developmentId": development["developmentId"],
        "privateProofId": final["proofId"],
        "datasetMatrixId": final["datasetMatrixId"],
        "datasetMatrix": development["datasetMatrix"],
        "counts": {
            "candidateStrategiesGenerated": final["candidateCount"],
            "backtestsCompleted": final["backtestCompletedCount"],
            "robustnessPassed": final["robustnessPassedCount"],
            "promotionEligible": final["promotionEligibleCount"],
            "finalHoldoutEvaluations": final["finalHoldoutEvaluationCount"],
        },
        "holdoutRunId": final["holdoutRunId"],
        "decisions": decisions,
        "approvals": {"paperApproved": False, "testnetApproved": False, "liveApproved": False},
    }
    receipt["receiptId"] = canonical_sha256(receipt)
    verify_promotion_receipt(receipt, candidate_manifest)
    return receipt


def verify_promotion_receipt(receipt: Mapping[str, Any], candidate_manifest: Mapping[str, Any]) -> None:
    if receipt.get("schemaVersion") != "stage-4a12.public-promotion-decision.v1" or receipt.get("labels") != RECEIPT_LABELS:
        raise ValueError("PROMOTION_RECEIPT_CONTRACT_INVALID")
    if not COMMIT_PATTERN.fullmatch(str(receipt.get("engineCommit", ""))):
        raise ValueError("PROMOTION_RECEIPT_COMMIT_INVALID")
    for key in ("candidateManifestId", "developmentId", "privateProofId", "datasetMatrixId", "receiptId"):
        if not SHA256_PATTERN.fullmatch(str(receipt.get(key, ""))):
            raise ValueError("PROMOTION_RECEIPT_DIGEST_INVALID")
    if receipt["candidateManifestId"] != candidate_manifest.get("manifestId"):
        raise ValueError("PROMOTION_RECEIPT_MANIFEST_MISMATCH")
    unsigned = dict(receipt)
    receipt_id = unsigned.pop("receiptId")
    if receipt_id != canonical_sha256(unsigned):
        raise ValueError("PROMOTION_RECEIPT_ID_INVALID")
    datasets = receipt.get("datasetMatrix")
    decisions = receipt.get("decisions")
    if not isinstance(datasets, list) or len(datasets) != 10 or {item.get("timeframe") for item in datasets} != {"5m", "4h"}:
        raise ValueError("PROMOTION_RECEIPT_DATA_MATRIX_INVALID")
    if any(item.get("gapPolicy") != "reject" or item.get("gapCount") != 0 for item in datasets):
        raise ValueError("PROMOTION_RECEIPT_GAP_INVALID")
    if not isinstance(decisions, list) or len(decisions) != candidate_manifest.get("candidateCount") or len(decisions) != 4:
        raise ValueError("PROMOTION_RECEIPT_CANDIDATE_COUNT_INVALID")
    counts = receipt.get("counts", {})
    if counts.get("candidateStrategiesGenerated") != 4 or counts.get("backtestsCompleted") != 4 or counts.get("finalHoldoutEvaluations") != 40:
        raise ValueError("PROMOTION_RECEIPT_COUNTS_INVALID")
    if counts.get("robustnessPassed") != sum(bool(item.get("robustnessPassed")) for item in decisions):
        raise ValueError("PROMOTION_RECEIPT_ROBUSTNESS_COUNT_INVALID")
    if counts.get("promotionEligible") != sum(bool(item.get("promotionEligible")) for item in decisions):
        raise ValueError("PROMOTION_RECEIPT_PROMOTION_COUNT_INVALID")
    for decision in decisions:
        if decision.get("selectionCount") != 9 or decision.get("validationAndTestUsedForFitting") is not False:
            raise ValueError("PROMOTION_RECEIPT_SELECTION_BIAS_INVALID")
        if decision.get("finalHoldoutEvaluationCount") != 10:
            raise ValueError("PROMOTION_RECEIPT_HOLDOUT_COUNT_INVALID")
        if any(decision.get(key) is not False for key in ("paperApproved", "testnetApproved", "liveApproved")):
            raise ValueError("PROMOTION_RECEIPT_APPROVAL_INVALID")
        if decision.get("paperReadinessReview") != decision.get("promotionEligible"):
            raise ValueError("PROMOTION_RECEIPT_REVIEW_STATE_INVALID")
    approvals = receipt.get("approvals", {})
    if approvals != {"paperApproved": False, "testnetApproved": False, "liveApproved": False}:
        raise ValueError("PROMOTION_RECEIPT_APPROVALS_INVALID")


def build_attestation_subject(receipt: Mapping[str, Any], receipt_commit: str) -> dict[str, Any]:
    if not COMMIT_PATTERN.fullmatch(receipt_commit):
        raise ValueError("PROMOTION_RECEIPT_ATTESTATION_COMMIT_INVALID")
    subject: dict[str, Any] = {
        "schemaVersion": "stage-4a12.attested-promotion-decision.v1",
        "labels": RECEIPT_LABELS,
        "receiptCommit": receipt_commit,
        "receipt": json.loads(json.dumps(receipt)),
    }
    subject["subjectId"] = canonical_sha256(subject)
    return subject
