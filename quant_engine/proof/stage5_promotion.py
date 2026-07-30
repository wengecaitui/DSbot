"""Stage 5.6-5.8 fail-closed robustness and promotion decision."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from typing import Any

from quant_engine.proof.stage5_evaluation import canonical_json_bytes, canonical_sha256


_GIT_SHA = re.compile(r"^[a-f0-9]{40}$")


def _parse(raw: bytes, label: str) -> dict[str, Any]:
    if not isinstance(raw, bytes):
        raise TypeError(f"{label}_RAW_MUST_BE_BYTES")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{label}_RAW_INVALID") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label}_NOT_OBJECT")
    canonical_json_bytes(value)
    return value


def _self_id(value: Mapping[str, Any], key: str, label: str) -> None:
    unsigned = dict(value)
    identity = unsigned.pop(key, None)
    if identity != canonical_sha256(unsigned):
        raise ValueError(f"{label}_IDENTITY_INVALID")


def build_stage5_promotion_decision(
    source_commit: str,
    entry_gate_raw: bytes,
    evaluation_raw: bytes,
    dataset_raw: bytes,
    registry_raw: bytes,
    results_raw: bytes,
    validation_raw: bytes,
) -> dict[str, Any]:
    if not isinstance(source_commit, str) or not _GIT_SHA.fullmatch(source_commit):
        raise ValueError("PROMOTION_SOURCE_COMMIT_INVALID")
    entry = _parse(entry_gate_raw, "ENTRY_GATE")
    evaluation = _parse(evaluation_raw, "EVALUATION_SPEC")
    dataset = _parse(dataset_raw, "DATASET_MANIFEST")
    registry = _parse(registry_raw, "CANDIDATE_REGISTRY")
    results = _parse(results_raw, "RESEARCH_RESULTS")
    validation = _parse(validation_raw, "VALIDATION_DECISION")
    if entry.get("gateId") != "987f264ee5079dc623c52edef254e89dc2dab09b18084b238c2d31bd629553d5" or entry.get("stage5Entered") is not True:
        raise ValueError("ENTRY_GATE_CONTRACT_INVALID")
    for value, key, label in (
        (evaluation, "evaluationSpecId", "EVALUATION_SPEC"),
        (dataset, "datasetManifestId", "DATASET_MANIFEST"), (registry, "registryId", "CANDIDATE_REGISTRY"),
        (results, "resultsId", "RESEARCH_RESULTS"), (validation, "decisionId", "VALIDATION_DECISION"),
    ):
        _self_id(value, key, label)
    raw_inputs = {
        "entryGate": {"id": entry["gateId"], "rawSha256": hashlib.sha256(entry_gate_raw).hexdigest()},
        "evaluationSpec": {"id": evaluation["evaluationSpecId"], "rawSha256": hashlib.sha256(evaluation_raw).hexdigest()},
        "datasetManifest": {"id": dataset["datasetManifestId"], "rawSha256": hashlib.sha256(dataset_raw).hexdigest()},
        "candidateRegistry": {"id": registry["registryId"], "rawSha256": hashlib.sha256(registry_raw).hexdigest()},
        "researchResults": {"id": results["resultsId"], "rawSha256": hashlib.sha256(results_raw).hexdigest()},
        "validationDecision": {"id": validation["decisionId"], "rawSha256": hashlib.sha256(validation_raw).hexdigest()},
    }
    if validation.get("inputs") != {
        "candidateRegistry": {"registryId": registry["registryId"], "rawSha256": raw_inputs["candidateRegistry"]["rawSha256"]},
        "evaluationSpec": {"evaluationSpecId": evaluation["evaluationSpecId"], "rawSha256": raw_inputs["evaluationSpec"]["rawSha256"]},
        "datasetManifest": {"datasetManifestId": dataset["datasetManifestId"], "rawSha256": raw_inputs["datasetManifest"]["rawSha256"]},
        "researchResults": {"resultsId": results["resultsId"], "rawSha256": raw_inputs["researchResults"]["rawSha256"]},
    }:
        raise ValueError("PROMOTION_VALIDATION_LINEAGE_INVALID")
    if validation.get("status") != "NO_CANDIDATE_PASSED_VALIDATION" or validation.get("frozenCandidate") is not None:
        raise ValueError("PROMOTION_UNEXPECTED_FROZEN_CANDIDATE")
    if validation.get("lockedTest") != {"state": "SEALED_UNOPENED", "accessCount": 0, "usedForSelection": False}:
        raise ValueError("PROMOTION_LOCKED_TEST_INVALID")
    if len(validation.get("candidates", [])) != 4 or len(results.get("evaluations", [])) != 12:
        raise ValueError("PROMOTION_CANDIDATE_COVERAGE_INVALID")
    safety = validation.get("safety", {})
    if safety.get("paperTestnetLiveCalls") != 0 or any(safety.get(key) is not False for key in ("activationAuthorized", "runtimeStarted", "paperApproved", "testnetApproved", "liveApproved")):
        raise ValueError("PROMOTION_SAFETY_INVALID")

    comparisons = []
    states = []
    for candidate in validation["candidates"]:
        if candidate.get("stateEvents", [])[-1].get("state") != "REJECTED_VALIDATION":
            raise ValueError("PROMOTION_STATE_SKIP_INVALID")
        parameters = candidate.get("parameterResults", [])
        if len(parameters) != 3 or any(item.get("passedValidation") is not False or not item.get("failureReasons") for item in parameters):
            raise ValueError("PROMOTION_PARAMETER_DECISION_INVALID")
        best = sorted(parameters, key=lambda item: (-float(item["validation"]["medianNetReturn"]), item["parameterId"]))[0]
        comparisons.append({
            "strategyId": candidate["strategyId"], "specId": candidate["specId"], "bestRejectedParameterId": best["parameterId"],
            "TRAIN": {key: best["train"][key] for key in ("medianNetReturn", "maximumAssetDrawdown", "aggregateSharpe", "aggregateSortino", "aggregateProfitFactor", "aggregateTradeCount", "medianTurnover", "medianCostBurden")},
            "VALIDATION": {key: best["validation"][key] for key in ("medianNetReturn", "maximumAssetDrawdown", "aggregateSharpe", "aggregateSortino", "aggregateProfitFactor", "aggregateTradeCount", "medianTurnover", "medianCostBurden")},
            "TEST": {"status": "NOT_RUN_BY_CONTRACT_NO_FROZEN_CANDIDATE"},
            "failureReasons": best["failureReasons"],
            "parameterSensitivity": candidate["parameterSensitivity"],
        })
        states.append({"strategyId": candidate["strategyId"], "specId": candidate["specId"], "finalState": "REJECTED_VALIDATION", "stateEvents": candidate["stateEvents"]})
    comparisons.sort(key=lambda item: item["strategyId"])
    states.sort(key=lambda item: item["strategyId"])
    decision: dict[str, Any] = {
        "schemaVersion": "stage-5.promotion-decision.v1",
        "stage": "STAGE 5.6-5.8",
        "status": "REJECTED_VALIDATION_NO_LOCKED_TEST_RUN",
        "sourceCommit": source_commit,
        "inputs": raw_inputs,
        "singleLockedTest": {"status": "SKIPPED_BY_CONTRACT_NO_FROZEN_CANDIDATE", "accessCount": 0, "testedCandidateCount": 0, "artifact": None},
        "robustnessAudit": {"status": "NOT_RUN_NO_VALIDATED_CANDIDATE", "result": "REJECTED_BEFORE_LOCKED_TEST", "overfitRisk": "HIGH", "structuredComparisons": comparisons},
        "promotionStateMachine": {"candidateStates": states, "transitionsSkipped": [], "manualOverrideAllowed": False},
        "promotion": {"approved": False, "decision": "NO_PROMOTED_STRATEGY", "promotedStrategyCount": 0, "promotedStrategyId": None, "paperReviewEligible": False},
        "safety": {"activationAuthorized": False, "runtimeStarted": False, "paperApproved": False, "testnetApproved": False, "liveApproved": False, "paperTestnetLiveCalls": 0},
    }
    decision["promotionReceiptId"] = canonical_sha256(decision)
    return decision


def verify_stage5_promotion_decision(
    decision: Mapping[str, Any], source_commit: str, entry_gate_raw: bytes,
    evaluation_raw: bytes, dataset_raw: bytes, registry_raw: bytes,
    results_raw: bytes, validation_raw: bytes,
) -> None:
    expected = build_stage5_promotion_decision(source_commit, entry_gate_raw, evaluation_raw, dataset_raw, registry_raw, results_raw, validation_raw)
    try:
        actual = canonical_json_bytes(decision)
    except (TypeError, ValueError) as error:
        raise ValueError("PROMOTION_DECISION_INVALID") from error
    if actual != canonical_json_bytes(expected):
        raise ValueError("PROMOTION_DECISION_MISMATCH")
