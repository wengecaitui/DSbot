#!/usr/bin/env python3
"""Build and verify the terminal Stage 4A closure audit."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from quant_engine.proof.evidence_governance import (
    verify_consumed_evidence_seed,
    verify_failure_attribution,
    verify_governance_contract,
)
from quant_engine.proof.promotion_receipt import verify_promotion_receipt
from quant_engine.proof.strategy_spec import canonical_sha256


STAGES = [
    ("4A4", "d735e270ce0f2fd335db3905ade2aec7474a2c6a"),
    ("4A5", "c1617a786950e424c3e1effc1941aa1c61ea5e49"),
    ("4A6", "4a913ae359be5f660c19cf71c83a0cb46e4a2cd6"),
    ("4A7", "9a702b919d864336261edce713b9dc468cbcb644"),
    ("4A8", "9e8c7f745c61229129d5f447b469c82af2b0a9b0"),
    ("4A9", "5a76014995f051a4cf594bcd98f52aeea25a8321"),
    ("4A10", "2e9df3dfb2e43825344a086abc274f326f9e8894"),
    ("4A11", "458aa6664b693e612760a29d30d26c080777d829"),
    ("4A12", "4b34e6a58e0b7bf93774bc8f3055fea60e28117d"),
    ("4A13", "88defe1973002d55950f45366bd7e9fc3ea93056"),
]
LABELS = [
    "STAGE 4A TERMINAL CLOSURE AUDIT",
    "NO STAGE 4A14 AUTHORIZED",
    "NOT APPROVED FOR PAPER, TESTNET OR LIVE",
]


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def verify_ancestry(commit: str) -> None:
    for stage, stage_commit in STAGES:
        result = subprocess.run(
            ["git", "merge-base", "--is-ancestor", stage_commit, commit],
            cwd=REPO,
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise ValueError(f"STAGE_4A_ANCESTRY_INVALID:{stage}")


def verify_tradeiq_receipt(receipt: dict) -> None:
    if receipt.get("schemaVersion") != "stage-4a10.public-private-proof-receipt.v1":
        raise ValueError("STAGE_4A_TRADEIQ_SCHEMA_INVALID")
    if not isinstance(receipt.get("receiptId"), str) or len(receipt["receiptId"]) != 64:
        raise ValueError("STAGE_4A_TRADEIQ_RECEIPT_ID_INVALID")
    if receipt.get("promotion", {}).get("eligible") is not False:
        raise ValueError("STAGE_4A_TRADEIQ_PROMOTION_INVALID")
    if receipt.get("proof", {}).get("finalHoldoutEvaluationCount") != 1:
        raise ValueError("STAGE_4A_TRADEIQ_HOLDOUT_COUNT_INVALID")


def build_audit(baseline_commit: str, artifacts: dict[str, dict]) -> dict:
    verify_ancestry(baseline_commit)
    manifest = artifacts["candidateManifest"]
    promotion = artifacts["promotionDecision"]
    failure = artifacts["failureAttribution"]
    seed = artifacts["consumedEvidenceSeed"]
    contract = artifacts["governanceContract"]
    tradeiq = artifacts["tradeIqReceipt"]
    verify_promotion_receipt(promotion, manifest)
    verify_failure_attribution(failure, manifest)
    verify_consumed_evidence_seed(seed, promotion, manifest)
    verify_governance_contract(contract)
    verify_tradeiq_receipt(tradeiq)
    if promotion["counts"]["promotionEligible"] != 0 or promotion["counts"]["robustnessPassed"] != 0:
        raise ValueError("STAGE_4A_CANDIDATE_PROMOTION_INVALID")

    audit: dict = {
        "schemaVersion": "stage-4a.closure-audit.v1",
        "labels": LABELS,
        "baselineCommit": baseline_commit,
        "closedStages": [{"stage": stage, "mergeCommit": commit} for stage, commit in STAGES],
        "closureEvidence": {
            "moduleRuntimeContract": "CommonJS Node runtime verified in Stage 4A4 and canonical CI",
            "referenceInfrastructureProof": True,
            "pineAssetsVerified": manifest["sourceAssetCounts"]["pineAssetsVerified"],
            "directStrategies": manifest["sourceAssetCounts"]["directStrategies"],
            "blockedLifecycleAssets": manifest["sourceAssetCounts"]["needsLifecycle"],
            "pureIndicators": manifest["sourceAssetCounts"]["pureIndicators"],
            "tradeIqFinalHoldoutEvaluations": tradeiq["proof"]["finalHoldoutEvaluationCount"],
            "tradeIqPromotionEligible": tradeiq["promotion"]["eligible"],
            "derivedCandidateCount": promotion["counts"]["candidateStrategiesGenerated"],
            "derivedBacktestsCompleted": promotion["counts"]["backtestsCompleted"],
            "derivedFinalHoldoutEvaluations": promotion["counts"]["finalHoldoutEvaluations"],
            "derivedRobustnessPassed": promotion["counts"]["robustnessPassed"],
            "derivedPromotionEligible": promotion["counts"]["promotionEligible"],
            "consumedEvidenceWindows": seed["windowCount"],
            "consumedEvidenceEvaluations": seed["evaluationCount"],
            "failureAttributionUsesFinalHoldout": failure["finalHoldoutUsedForAttribution"],
            "strategyDesignUsesFinalHoldout": failure["finalHoldoutUsedForDesign"],
            "freshEvidenceWindowAvailable": contract["freshEvidenceWindowAvailable"],
            "nextGenerationFrozenSpecCount": contract["nextGenerationFrozenSpecCount"],
        },
        "artifactBindings": {
            "tradeIqReceiptId": tradeiq["receiptId"],
            "candidateManifestId": manifest["manifestId"],
            "promotionDecisionReceiptId": promotion["receiptId"],
            "failureAttributionReportId": failure["reportId"],
            "consumedEvidenceSeedId": seed["seedId"],
            "evidenceGovernanceContractId": contract["contractId"],
        },
        "stage4AClosed": True,
        "stage4A14Authorized": False,
        "nextStage": "STAGE 4B1 STRATEGY ACTIVATION CONTRACT",
        "paperApproved": False,
        "testnetApproved": False,
        "liveApproved": False,
        "liveExecutionChanges": False,
    }
    audit["auditId"] = canonical_sha256(audit)
    return audit


def verify_audit(audit: dict, artifacts: dict[str, dict]) -> None:
    if audit.get("schemaVersion") != "stage-4a.closure-audit.v1" or audit.get("labels") != LABELS:
        raise ValueError("STAGE_4A_AUDIT_SCHEMA_INVALID")
    unsigned = dict(audit)
    audit_id = unsigned.pop("auditId", None)
    if audit_id != canonical_sha256(unsigned):
        raise ValueError("STAGE_4A_AUDIT_ID_INVALID")
    rebuilt = build_audit(audit["baselineCommit"], artifacts)
    if rebuilt != audit:
        raise ValueError("STAGE_4A_AUDIT_RECOMPUTATION_MISMATCH")
    if audit.get("stage4AClosed") is not True or audit.get("stage4A14Authorized") is not False:
        raise ValueError("STAGE_4A_TERMINAL_STATE_INVALID")
    if any(audit.get(key) is not False for key in ("paperApproved", "testnetApproved", "liveApproved", "liveExecutionChanges")):
        raise ValueError("STAGE_4A_APPROVAL_INVALID")


def load_artifacts(args: argparse.Namespace) -> dict[str, dict]:
    return {
        "candidateManifest": read_json(args.candidate_manifest),
        "promotionDecision": read_json(args.promotion_decision),
        "failureAttribution": read_json(args.failure_attribution),
        "consumedEvidenceSeed": read_json(args.consumed_evidence_seed),
        "governanceContract": read_json(args.governance_contract),
        "tradeIqReceipt": read_json(args.tradeiq_receipt),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-manifest", type=Path, required=True)
    parser.add_argument("--promotion-decision", type=Path, required=True)
    parser.add_argument("--failure-attribution", type=Path, required=True)
    parser.add_argument("--consumed-evidence-seed", type=Path, required=True)
    parser.add_argument("--governance-contract", type=Path, required=True)
    parser.add_argument("--tradeiq-receipt", type=Path, required=True)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--baseline-commit")
    parser.add_argument("--build", action="store_true")
    parser.add_argument("--receipt-commit")
    parser.add_argument("--subject-output", type=Path)
    args = parser.parse_args()
    tradeiq_verify = subprocess.run(
        ["node", "scripts/verify-tradeiq-proof-receipt.mjs", str(args.tradeiq_receipt)],
        cwd=REPO,
        check=False,
        capture_output=True,
        text=True,
    )
    if tradeiq_verify.returncode != 0:
        raise ValueError(f"STAGE_4A_TRADEIQ_VERIFICATION_FAILED:{tradeiq_verify.stderr.strip()}")
    artifacts = load_artifacts(args)
    if args.build:
        if not args.baseline_commit:
            raise SystemExit("STAGE_4A_BUILD_BASELINE_REQUIRED")
        write_json(args.audit, build_audit(args.baseline_commit, artifacts))
    audit = read_json(args.audit)
    verify_audit(audit, artifacts)
    if args.receipt_commit or args.subject_output:
        if not args.receipt_commit or not args.subject_output:
            raise SystemExit("STAGE_4A_ATTESTATION_ARGS_INVALID")
        subject = {
            "schemaVersion": "stage-4a.attested-closure-audit.v1",
            "labels": LABELS,
            "receiptCommit": args.receipt_commit,
            "auditId": audit["auditId"],
            "baselineCommit": audit["baselineCommit"],
            "stage4AClosed": True,
            "stage4A14Authorized": False,
            "paperApproved": False,
            "testnetApproved": False,
            "liveApproved": False,
        }
        subject["subjectId"] = canonical_sha256(subject)
        write_json(args.subject_output, subject)
    print(json.dumps({"auditId": audit["auditId"], "stage4AClosed": True, "nextStage": audit["nextStage"]}, sort_keys=True))


if __name__ == "__main__":
    main()
