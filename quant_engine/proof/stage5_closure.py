"""Stage 5.9 closure — deterministic final seal over all Stage 5 artifacts."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from typing import Any

from quant_engine.proof.stage5_evaluation import canonical_json_bytes, canonical_sha256
from quant_engine.proof.stage5_promotion import verify_stage5_promotion_decision

SCHEMA_VERSION = "stage-5.closure.v1"
INITIAL_BASELINE_SHA = "818770767eab0a7173292b614b6e699a9ce310a1"

MERGE_COMMITS = {
    "5.1": "913646777a64aa801c7dc263701802249164bf97",
    "5.2": "f7ee27391067c77112a1754ab5c99fc9a5adb6a3",
    "5.2-fix": "8c87c86107bf32c7e9f2fd4d494a22d612dcf1b8",
    "5.3-5.4": "2115bfa277d2ca2eb582a010e248f369096cb6fa",
    "5.5-5.8": "3cbf9b88e7929b5649b84094d77f1492919b2453",
    "security": "b9634af97e226b80890464eadb2f4c4c16b128f3",
}

AUTHORITATIVE_RAW_SHA256 = {
    "entryGate": "b33502d272d7c4bd13c9863518600bb6a1c19cf6e52bf150161f4d494c296c28",
    "evaluationSpec": "62bf8ccf9fc18b2818c1d24d05426128092e5dd464760daed89986a947adbc1b",
    "datasetManifest": "c46a5b5a6c6ed831c8de3248b5826f27afd1f1b93154fa7d52d652bff68b4cd4",
    "candidateRegistry": "8364dd6bcb68b318d2550d726c286c24ff4cfbef53e7f698ca3b38db20d1fa7e",
    "researchResults": "9b0eda9677b63242632a8c3288e902007539fa113ea1362c4ec396e6dfc60186",
    "validationDecision": "edcacb3e73d9ab4788ebaabd84db64f9eb5a29cc839e2d010adf83f1206f6a34",
    "promotionDecision": "bb7413ff053e368b1499e76e084429a4504faaee4741e39e1606bad9ac930cf9",
}

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


def _verify_self_id(value: Mapping[str, Any], id_key: str, label: str) -> None:
    unsigned = dict(value)
    identity = unsigned.pop(id_key, None)
    if not isinstance(identity, str) or identity != canonical_sha256(unsigned):
        raise ValueError(f"{label}_IDENTITY_INVALID")


def _digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _validate_upstream_artifacts(
    entry: dict[str, Any],
    evaluation: dict[str, Any],
    dataset: dict[str, Any],
    registry: dict[str, Any],
    results: dict[str, Any],
    validation: dict[str, Any],
    promotion: dict[str, Any],
    raw_digests: dict[str, str],
) -> None:
    """Verify all upstream artifacts are valid and consistent."""

    # ── entry gate ────────────────────────────────────────────────────
    if entry.get("gateId") != "987f264ee5079dc623c52edef254e89dc2dab09b18084b238c2d31bd629553d5":
        raise ValueError("CLOSURE_ENTRY_GATE_CONTRACT_INVALID")
    if entry.get("stage5Entered") is not True:
        raise ValueError("CLOSURE_ENTRY_GATE_NOT_ENTERED")
    if entry.get("status") != "BLOCKED_NO_PROMOTED_STRATEGY":
        raise ValueError("CLOSURE_ENTRY_GATE_STATUS_INVALID")

    # ── self-ID checks ────────────────────────────────────────────────
    for value, key, label in (
        (evaluation, "evaluationSpecId", "EVALUATION_SPEC"),
        (dataset, "datasetManifestId", "DATASET_MANIFEST"),
        (registry, "registryId", "CANDIDATE_REGISTRY"),
        (results, "resultsId", "RESEARCH_RESULTS"),
        (validation, "decisionId", "VALIDATION_DECISION"),
        (promotion, "promotionReceiptId", "PROMOTION_DECISION"),
    ):
        _verify_self_id(value, key, label)

    # ── cross-reference validation ────────────────────────────────────
    if validation.get("inputs", {}).get("candidateRegistry", {}).get("rawSha256") != raw_digests["candidateRegistry"]:
        raise ValueError("CLOSURE_VALIDATION_REGISTRY_LINEAGE_INVALID")
    if validation.get("inputs", {}).get("evaluationSpec", {}).get("rawSha256") != raw_digests["evaluationSpec"]:
        raise ValueError("CLOSURE_VALIDATION_EVALUATION_LINEAGE_INVALID")
    if validation.get("inputs", {}).get("datasetManifest", {}).get("rawSha256") != raw_digests["datasetManifest"]:
        raise ValueError("CLOSURE_VALIDATION_DATASET_LINEAGE_INVALID")
    if validation.get("inputs", {}).get("researchResults", {}).get("rawSha256") != raw_digests["researchResults"]:
        raise ValueError("CLOSURE_VALIDATION_RESULTS_LINEAGE_INVALID")

    # ── promotion cross-reference ─────────────────────────────────────
    promotion_inputs = promotion.get("inputs", {})
    if promotion_inputs.get("candidateRegistry", {}).get("rawSha256") != raw_digests["candidateRegistry"]:
        raise ValueError("CLOSURE_PROMOTION_REGISTRY_LINEAGE_INVALID")
    if promotion_inputs.get("datasetManifest", {}).get("rawSha256") != raw_digests["datasetManifest"]:
        raise ValueError("CLOSURE_PROMOTION_DATASET_LINEAGE_INVALID")
    if promotion_inputs.get("entryGate", {}).get("rawSha256") != raw_digests["entryGate"]:
        raise ValueError("CLOSURE_PROMOTION_ENTRY_LINEAGE_INVALID")
    if promotion_inputs.get("evaluationSpec", {}).get("rawSha256") != raw_digests["evaluationSpec"]:
        raise ValueError("CLOSURE_PROMOTION_EVALUATION_LINEAGE_INVALID")
    if promotion_inputs.get("researchResults", {}).get("rawSha256") != raw_digests["researchResults"]:
        raise ValueError("CLOSURE_PROMOTION_RESULTS_LINEAGE_INVALID")
    if promotion_inputs.get("validationDecision", {}).get("rawSha256") != raw_digests["validationDecision"]:
        raise ValueError("CLOSURE_PROMOTION_VALIDATION_LINEAGE_INVALID")

    # ── terminal state enforcement ────────────────────────────────────
    if validation.get("status") != "NO_CANDIDATE_PASSED_VALIDATION":
        raise ValueError("CLOSURE_VALIDATION_STATUS_INVALID")
    if validation.get("frozenCandidate") is not None:
        raise ValueError("CLOSURE_FROZEN_CANDIDATE_UNEXPECTED")
    if validation.get("lockedTest") != {"state": "SEALED_UNOPENED", "accessCount": 0, "usedForSelection": False}:
        raise ValueError("CLOSURE_LOCKED_TEST_INVALID")
    if len(validation.get("candidates", [])) != 4:
        raise ValueError("CLOSURE_CANDIDATE_COUNT_INVALID")
    if len(results.get("evaluations", [])) != 12:
        raise ValueError("CLOSURE_PARAMETER_SET_COUNT_INVALID")
    if results.get("lockedTestAccessCount") != 0 or results.get("phases") != ["TRAIN", "VALIDATION"]:
        raise ValueError("CLOSURE_RESEARCH_PHASE_BOUNDARY_INVALID")

    promotion_terminal = promotion.get("promotion", {})
    if promotion_terminal.get("approved") is not False:
        raise ValueError("CLOSURE_PROMOTION_APPROVED_UNEXPECTED")
    if promotion_terminal.get("decision") != "NO_PROMOTED_STRATEGY":
        raise ValueError("CLOSURE_PROMOTION_DECISION_INVALID")
    if promotion_terminal.get("promotedStrategyCount") != 0:
        raise ValueError("CLOSURE_PROMOTED_COUNT_INVALID")
    if promotion_terminal.get("promotedStrategyId") is not None:
        raise ValueError("CLOSURE_PROMOTED_ID_INVALID")
    if promotion_terminal.get("paperReviewEligible") is not False:
        raise ValueError("CLOSURE_PAPER_REVIEW_INVALID")

    # ── all candidates REJECTED_VALIDATION ────────────────────────────
    candidates = validation.get("candidates", [])
    for candidate in candidates:
        events = candidate.get("stateEvents", [])
        if not events or events[-1].get("state") != "REJECTED_VALIDATION":
            raise ValueError("CLOSURE_CANDIDATE_NOT_REJECTED")
    if len(candidates) != 4:
        raise ValueError("CLOSURE_CANDIDATE_REJECTION_COUNT_INVALID")

    # ── Stage 5.6-5.8 state ───────────────────────────────────────────
    locked_test = promotion.get("singleLockedTest", {})
    if locked_test.get("status") != "SKIPPED_BY_CONTRACT_NO_FROZEN_CANDIDATE":
        raise ValueError("CLOSURE_LOCKED_TEST_STATUS_INVALID")
    if locked_test.get("accessCount") != 0:
        raise ValueError("CLOSURE_LOCKED_TEST_ACCESS_INVALID")
    robustness = promotion.get("robustnessAudit", {})
    if robustness.get("status") != "NOT_RUN_NO_VALIDATED_CANDIDATE":
        raise ValueError("CLOSURE_ROBUSTNESS_STATUS_INVALID")
    if robustness.get("result") != "REJECTED_BEFORE_LOCKED_TEST":
        raise ValueError("CLOSURE_ROBUSTNESS_RESULT_INVALID")
    if robustness.get("overfitRisk") != "HIGH":
        raise ValueError("CLOSURE_OVERFIT_RISK_INVALID")

    # ── safety enforcement ────────────────────────────────────────────
    # Entry gate has top-level safety flags
    for key in ("activationAuthorized", "runtimeStarted", "paperApproved", "testnetApproved", "liveApproved"):
        if entry.get(key) is not False:
            raise ValueError(f"CLOSURE_ENTRY_GATE_SAFETY_{key}_INVALID")

    # Other artifacts have nested safety objects
    for source, label in (
        (evaluation, "EVALUATION_SPEC"),
        (validation, "VALIDATION_DECISION"),
        (promotion, "PROMOTION_DECISION"),
    ):
        safety = source.get("safety", {})
        if safety.get("paperTestnetLiveCalls") != 0:
            raise ValueError(f"CLOSURE_{label}_SAFETY_CALLS_INVALID")
        for key in ("activationAuthorized", "runtimeStarted", "paperApproved", "testnetApproved", "liveApproved"):
            if safety.get(key) is not False:
                raise ValueError(f"CLOSURE_{label}_SAFETY_{key}_INVALID")

    # ── source commit format validation ───────────────────────────────
    for label, commit in (
        ("VALIDATION_DECISION", validation.get("sourceCommit")),
        ("PROMOTION_DECISION", promotion.get("sourceCommit")),
    ):
        if not isinstance(commit, str) or not _GIT_SHA.fullmatch(commit):
            raise ValueError(f"CLOSURE_{label}_SOURCE_COMMIT_INVALID")


def build_stage5_closure(
    entry_gate_raw: bytes,
    evaluation_raw: bytes,
    dataset_raw: bytes,
    registry_raw: bytes,
    research_results_raw: bytes,
    validation_decision_raw: bytes,
    promotion_decision_raw: bytes,
    source_commit: str,
    final_target_sha: str,
) -> dict[str, Any]:
    if not isinstance(source_commit, str) or not _GIT_SHA.fullmatch(source_commit):
        raise ValueError("CLOSURE_SOURCE_COMMIT_INVALID")
    if not isinstance(final_target_sha, str) or not _GIT_SHA.fullmatch(final_target_sha):
        raise ValueError("CLOSURE_FINAL_TARGET_SHA_INVALID")
    if source_commit != final_target_sha:
        raise ValueError("CLOSURE_SOURCE_TARGET_SHA_MISMATCH")

    # Parse all upstream artifacts
    entry = _parse(entry_gate_raw, "ENTRY_GATE")
    evaluation = _parse(evaluation_raw, "EVALUATION_SPEC")
    dataset = _parse(dataset_raw, "DATASET_MANIFEST")
    registry = _parse(registry_raw, "CANDIDATE_REGISTRY")
    results = _parse(research_results_raw, "RESEARCH_RESULTS")
    validation = _parse(validation_decision_raw, "VALIDATION_DECISION")
    promotion = _parse(promotion_decision_raw, "PROMOTION_DECISION")

    # Recompute the complete promotion receipt from its authoritative inputs.
    # A matching self-ID alone is not sufficient because an attacker could
    # rewrite a receipt and recompute that ID.
    verify_stage5_promotion_decision(
        promotion,
        promotion.get("sourceCommit"),
        entry_gate_raw,
        evaluation_raw,
        dataset_raw,
        registry_raw,
        research_results_raw,
        validation_decision_raw,
    )

    # Compute raw digests
    raw_digests = {
        "entryGate": _digest(entry_gate_raw),
        "evaluationSpec": _digest(evaluation_raw),
        "datasetManifest": _digest(dataset_raw),
        "candidateRegistry": _digest(registry_raw),
        "researchResults": _digest(research_results_raw),
        "validationDecision": _digest(validation_decision_raw),
        "promotionDecision": _digest(promotion_decision_raw),
    }
    if raw_digests != AUTHORITATIVE_RAW_SHA256:
        mismatches = sorted(
            key for key, expected in AUTHORITATIVE_RAW_SHA256.items()
            if raw_digests.get(key) != expected
        )
        raise ValueError(f"CLOSURE_AUTHORITATIVE_RAW_SHA256_MISMATCH:{','.join(mismatches)}")

    # Validate all upstream artifacts
    _validate_upstream_artifacts(
        entry, evaluation, dataset, registry, results,
        validation, promotion, raw_digests,
    )

    # Build inputs section with self-IDs and raw digests
    inputs = {
        "entryGate": {"id": entry["gateId"], "rawSha256": raw_digests["entryGate"]},
        "evaluationSpec": {"id": evaluation["evaluationSpecId"], "rawSha256": raw_digests["evaluationSpec"]},
        "datasetManifest": {"id": dataset["datasetManifestId"], "rawSha256": raw_digests["datasetManifest"]},
        "candidateRegistry": {"id": registry["registryId"], "rawSha256": raw_digests["candidateRegistry"]},
        "researchResults": {"id": results["resultsId"], "rawSha256": raw_digests["researchResults"]},
        "validationDecision": {"id": validation["decisionId"], "rawSha256": raw_digests["validationDecision"]},
        "promotionDecision": {"id": promotion["promotionReceiptId"], "rawSha256": raw_digests["promotionDecision"]},
    }

    closure: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "stage": "STAGE 5.9",
        "stage5Closed": True,
        "status": "CLOSED_NO_PROMOTED_STRATEGY",
        "initialBaseline": INITIAL_BASELINE_SHA,
        "sourceCommit": source_commit,
        "finalTargetSha": final_target_sha,
        "mergeCommits": dict(MERGE_COMMITS),
        "inputs": inputs,
        "terminalState": {
            "promotion": {
                "decision": "NO_PROMOTED_STRATEGY",
                "promotedStrategyCount": 0,
                "promotedStrategyId": None,
                "paperReviewEligible": False,
            },
            "researchCoverage": {
                "candidateCount": 4,
                "parameterSetCount": 12,
                "frozenCandidate": None,
                "lockedTestState": "SEALED_UNOPENED",
                "lockedTestAccessCount": 0,
            },
            "stage5.6Status": "SKIPPED_BY_CONTRACT_NO_FROZEN_CANDIDATE",
            "robustnessStatus": "NOT_RUN_NO_VALIDATED_CANDIDATE",
            "robustnessResult": "REJECTED_BEFORE_LOCKED_TEST",
            "overfitRisk": "HIGH",
            "allCandidatesRejectedValidation": True,
            "frozenCandidateReceipt": None,
            "lockedTestArtifact": None,
            "robustnessArtifact": None,
            "absentEvidence": {
                "frozenCandidateReceipt": "ABSENT_BY_CONTRACT",
                "lockedTestArtifact": "ABSENT_BY_CONTRACT",
                "robustnessArtifact": "ABSENT_BY_CONTRACT",
            },
        },
        "safety": {
            "activationAuthorized": False,
            "runtimeStarted": False,
            "paperApproved": False,
            "testnetApproved": False,
            "liveApproved": False,
            "paperTestnetLiveCalls": 0,
        },
    }
    closure["closureId"] = canonical_sha256(closure)
    return closure


def verify_stage5_closure(
    decision: Mapping[str, Any],
    entry_gate_raw: bytes,
    evaluation_raw: bytes,
    dataset_raw: bytes,
    registry_raw: bytes,
    research_results_raw: bytes,
    validation_decision_raw: bytes,
    promotion_decision_raw: bytes,
    source_commit: str,
    final_target_sha: str,
) -> None:
    expected = build_stage5_closure(
        entry_gate_raw,
        evaluation_raw,
        dataset_raw,
        registry_raw,
        research_results_raw,
        validation_decision_raw,
        promotion_decision_raw,
        source_commit,
        final_target_sha,
    )
    try:
        actual = canonical_json_bytes(decision)
    except (TypeError, ValueError) as error:
        raise ValueError("CLOSURE_DECISION_INVALID") from error
    if actual != canonical_json_bytes(expected):
        raise ValueError("CLOSURE_DECISION_MISMATCH")
