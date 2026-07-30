"""Frozen Stage 5 candidate registry and lineage verifier."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from typing import Any

from quant_engine.proof.stage5_evaluation import canonical_json_bytes, canonical_sha256


SCHEMA_VERSION = "stage-5.candidate-registry.v1"
CANDIDATE_RAW_SHA256 = "919146d3a73e22f9b3732aa735ff8fab967a2d4f9eb9bb57ce4a3a5d86734899"
CANDIDATE_MANIFEST_ID = "7ba0079a9d0c12562562378d598372a46f4290adb527264a61558f9ed70201aa"
CANDIDATE_SOURCE_COMMIT = "80f12966081e3851424f820dd3428249d5537eb9"
EVALUATION_RAW_SHA256 = "62bf8ccf9fc18b2818c1d24d05426128092e5dd464760daed89986a947adbc1b"
EVALUATION_SPEC_ID = "8248f250d85a78dca564dad07064748d261ed08465477156783c69ffc00a2cf3"
DATASET_RAW_SHA256 = "c46a5b5a6c6ed831c8de3248b5826f27afd1f1b93154fa7d52d652bff68b4cd4"
DATASET_MANIFEST_ID = "3f9e3a1270b9479bd01767adcc5a6596132cb6c3734aa600e23ad25bc4abe760"
_GIT_SHA = re.compile(r"^[a-f0-9]{40}$")


def _parse_exact(raw: bytes, digest: str, label: str) -> dict[str, Any]:
    if not isinstance(raw, bytes):
        raise TypeError(f"{label}_RAW_MUST_BE_BYTES")
    if hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError(f"{label}_RAW_SHA256_MISMATCH")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"{label}_RAW_INVALID") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label}_NOT_OBJECT")
    canonical_json_bytes(value)
    return value


def _verify_self_id(value: Mapping[str, Any], key: str, expected: str, label: str) -> None:
    unsigned = dict(value)
    identity = unsigned.pop(key, None)
    if identity != expected or identity != canonical_sha256(unsigned):
        raise ValueError(f"{label}_IDENTITY_INVALID")


def _verify_inputs(
    candidate_raw: bytes,
    evaluation_raw: bytes,
    dataset_raw: bytes,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    candidate = _parse_exact(candidate_raw, CANDIDATE_RAW_SHA256, "CANDIDATE_MANIFEST")
    evaluation = _parse_exact(evaluation_raw, EVALUATION_RAW_SHA256, "EVALUATION_SPEC")
    dataset = _parse_exact(dataset_raw, DATASET_RAW_SHA256, "DATASET_MANIFEST")

    _verify_self_id(candidate, "manifestId", CANDIDATE_MANIFEST_ID, "CANDIDATE_MANIFEST")
    _verify_self_id(evaluation, "evaluationSpecId", EVALUATION_SPEC_ID, "EVALUATION_SPEC")
    _verify_self_id(dataset, "datasetManifestId", DATASET_MANIFEST_ID, "DATASET_MANIFEST")
    if candidate.get("sourceCommit") != CANDIDATE_SOURCE_COMMIT or candidate.get("candidateCount") != 4:
        raise ValueError("CANDIDATE_MANIFEST_CONTRACT_INVALID")
    if candidate.get("blockedLifecycleAssetsRemainBlocked") is not True:
        raise ValueError("BLOCKED_ASSET_CONTRACT_INVALID")
    if evaluation.get("status") != "FROZEN_BEFORE_DATA_ACCESS" or evaluation.get("searchBudget") != {
        "candidateSource": "ALL_FOUR_STAGE_4A12_CANDIDATES_WITH_LINEAGE",
        "lockedTestAccessPerStage5": 1,
        "maxCandidatesPerRound": 4,
        "maxPromotedStrategies": 1,
        "maxResearchRounds": 1,
        "unlimitedSearch": False,
    }:
        raise ValueError("EVALUATION_SEARCH_BUDGET_INVALID")
    lineage = evaluation.get("evaluationLineage", {})
    if lineage.get("stage4A12CandidateManifestRawSha256") != CANDIDATE_RAW_SHA256:
        raise ValueError("CANDIDATE_LINEAGE_DIGEST_MISMATCH")
    if lineage.get("stage4A12CandidateManifestSourceCommit") != CANDIDATE_SOURCE_COMMIT:
        raise ValueError("CANDIDATE_LINEAGE_COMMIT_MISMATCH")
    locked = dataset.get("splitManifest", {}).get("LOCKED_TEST", {})
    if locked.get("state") != "SEALED_UNOPENED" or locked.get("accessCount") != 0:
        raise ValueError("LOCKED_TEST_ALREADY_OPENED")
    if locked.get("rawRowsSha256") is not None or locked.get("normalizedSha256") is not None:
        raise ValueError("LOCKED_TEST_DIGEST_PRESENT")
    for source in (evaluation, dataset):
        safety = source.get("safety", {})
        if safety.get("paperTestnetLiveCalls") != 0 or any(
            safety.get(key) is not False
            for key in ("activationAuthorized", "runtimeStarted", "paperApproved", "testnetApproved", "liveApproved")
        ):
            raise ValueError("UPSTREAM_SAFETY_INVALID")
    return candidate, evaluation, dataset


def build_stage5_candidate_registry(
    source_commit: str,
    candidate_raw: bytes,
    evaluation_raw: bytes,
    dataset_raw: bytes,
) -> dict[str, Any]:
    if not isinstance(source_commit, str) or not _GIT_SHA.fullmatch(source_commit):
        raise ValueError("CANDIDATE_REGISTRY_SOURCE_COMMIT_INVALID")
    candidate, evaluation, dataset = _verify_inputs(candidate_raw, evaluation_raw, dataset_raw)
    expected_lineage = {
        (item.get("strategyId"), item.get("specId"))
        for item in evaluation["evaluationLineage"]["candidates"]
    }
    specs = candidate.get("specs")
    if not isinstance(specs, list) or len(specs) != 4:
        raise ValueError("CANDIDATE_SPEC_CARDINALITY_INVALID")

    entries = []
    seen: set[tuple[str, str]] = set()
    for spec in specs:
        if not isinstance(spec, dict):
            raise ValueError("CANDIDATE_SPEC_INVALID")
        unsigned_spec = dict(spec)
        spec_id = unsigned_spec.pop("specId", None)
        if spec_id != canonical_sha256(unsigned_spec):
            raise ValueError("CANDIDATE_SPEC_ID_INVALID")
        pair = (spec.get("strategyId"), spec_id)
        if pair in seen:
            raise ValueError("CANDIDATE_SPEC_DUPLICATE")
        seen.add(pair)
        parameter_values = spec.get("parameters", {}).get("candidateSets")
        if not isinstance(parameter_values, list) or len(parameter_values) != 3:
            raise ValueError("CANDIDATE_PARAMETER_CARDINALITY_INVALID")
        parameters = [
            {"parameterId": canonical_sha256(value), "values": json.loads(canonical_json_bytes(value))}
            for value in parameter_values
        ]
        if len({item["parameterId"] for item in parameters}) != 3:
            raise ValueError("CANDIDATE_PARAMETER_DUPLICATE")
        entries.append({
            "strategyId": spec["strategyId"],
            "specId": spec_id,
            "status": "REGISTERED",
            "spec": json.loads(canonical_json_bytes(spec)),
            "parameterSets": sorted(parameters, key=lambda item: item["parameterId"]),
            "evaluationEvents": [{"sequence": 1, "state": "REGISTERED"}],
            "failureReasons": [],
        })
    if seen != expected_lineage:
        raise ValueError("CANDIDATE_EVALUATION_LINEAGE_MISMATCH")
    entries.sort(key=lambda item: item["strategyId"])

    lexical_candidate = entries[0]
    lexical_parameter = lexical_candidate["parameterSets"][0]
    registry: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "stage": "STAGE 5.3",
        "status": "CANDIDATES_REGISTERED_LOCKED_TEST_SEALED",
        "sourceCommit": source_commit,
        "inputs": {
            "candidateManifest": {"rawSha256": CANDIDATE_RAW_SHA256, "manifestId": CANDIDATE_MANIFEST_ID, "sourceCommit": CANDIDATE_SOURCE_COMMIT},
            "evaluationSpec": {"rawSha256": EVALUATION_RAW_SHA256, "evaluationSpecId": EVALUATION_SPEC_ID, "sourceCommit": evaluation["sourceCommit"]},
            "datasetManifest": {"rawSha256": DATASET_RAW_SHA256, "datasetManifestId": DATASET_MANIFEST_ID, "sourceCommit": dataset["sourceCommit"]},
        },
        "searchBudget": {
            "researchRounds": 1,
            "candidates": 4,
            "parameterSets": 12,
            "promotionsMax": 1,
            "lockedTestAccess": 1,
        },
        "baselines": [
            {"baselineId": "baseline-no-trade-v1", "type": "NO_TRADE", "rankable": False, "candidateBudgetConsumed": False, "expectedTradeCount": 0, "expectedNetReturn": 0.0},
            {"baselineId": "baseline-existing-spec-lexical-v1", "type": "EXISTING_DETERMINISTIC_SPEC", "rankable": False, "candidateBudgetConsumed": False, "strategyId": lexical_candidate["strategyId"], "specId": lexical_candidate["specId"], "parameterId": lexical_parameter["parameterId"], "selectionReason": "LEXICAL_PRECOMMIT_NOT_PERFORMANCE"},
        ],
        "candidates": entries,
        "auditContract": {"appendOnly": True, "stateTransitionsNotYetRecorded": True, "failureCount": 0},
        "lockedTest": {"state": "SEALED_UNOPENED", "accessCount": 0, "usedForRegistration": False},
        "safety": {"offlineOnly": True, "paperTestnetLiveCalls": 0, "activationAuthorized": False, "runtimeStarted": False, "paperApproved": False, "testnetApproved": False, "liveApproved": False},
    }
    registry["registryId"] = canonical_sha256(registry)
    return registry


def verify_stage5_candidate_registry(
    registry: Mapping[str, Any],
    source_commit: str,
    candidate_raw: bytes,
    evaluation_raw: bytes,
    dataset_raw: bytes,
) -> None:
    if not isinstance(registry, Mapping):
        raise ValueError("CANDIDATE_REGISTRY_NOT_MAPPING")
    try:
        expected = build_stage5_candidate_registry(source_commit, candidate_raw, evaluation_raw, dataset_raw)
        actual = canonical_json_bytes(registry)
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("CANDIDATE_REGISTRY_INVALID") from error
    if actual != canonical_json_bytes(expected):
        raise ValueError("CANDIDATE_REGISTRY_MISMATCH")
