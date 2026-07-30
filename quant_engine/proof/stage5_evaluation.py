"""Stage 5.1 evaluation constitution - frozen before market-data access."""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping, Sequence
from typing import Any


SCHEMA_VERSION = "stage-5.evaluation-spec.v1"
INITIAL_BASELINE_SHA = "818770767eab0a7173292b614b6e699a9ce310a1"
ENTRY_GATE_ID = "987f264ee5079dc623c52edef254e89dc2dab09b18084b238c2d31bd629553d5"
ENTRY_GATE_RAW_SHA256 = "b33502d272d7c4bd13c9863518600bb6a1c19cf6e52bf150161f4d494c296c28"
ENTRY_GATE_WORKFLOW_RUN_ID = 30530350135
_GIT_SHA = re.compile(r"^[a-f0-9]{40}$")


def _plain_json(value: Any, active: set[int] | None = None) -> Any:
    """Return a plain JSON value while rejecting ambiguous or unsafe values."""
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("CANONICAL_JSON_NON_FINITE_NUMBER")
        return 0.0 if value == 0.0 else value
    if isinstance(value, (bytes, bytearray, memoryview)):
        raise TypeError("CANONICAL_JSON_BYTES_UNSUPPORTED")

    if active is None:
        active = set()
    identity = id(value)
    if identity in active:
        raise ValueError("CANONICAL_JSON_CYCLE")

    if isinstance(value, Mapping):
        active.add(identity)
        try:
            result: dict[str, Any] = {}
            for key, item in value.items():
                if not isinstance(key, str):
                    raise TypeError("CANONICAL_JSON_NON_STRING_KEY")
                result[key] = _plain_json(item, active)
            return result
        finally:
            active.remove(identity)

    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray, memoryview)):
        active.add(identity)
        try:
            return [_plain_json(item, active) for item in value]
        finally:
            active.remove(identity)

    raise TypeError(f"CANONICAL_JSON_UNSUPPORTED_TYPE:{type(value).__name__}")


def canonical_json_bytes(value: Any) -> bytes:
    normalized = _plain_json(value)
    return json.dumps(
        normalized,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _verify_entry_gate(entry_gate_raw: bytes) -> None:
    if not isinstance(entry_gate_raw, bytes):
        raise TypeError("STAGE5_ENTRY_RAW_MUST_BE_BYTES")
    if hashlib.sha256(entry_gate_raw).hexdigest() != ENTRY_GATE_RAW_SHA256:
        raise ValueError("STAGE5_ENTRY_RAW_SHA256_MISMATCH")
    try:
        gate = json.loads(entry_gate_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("STAGE5_ENTRY_RAW_INVALID_JSON") from error
    required = {
        "schemaVersion": "stage-5.entry-gate.v1",
        "stage": "STAGE 5",
        "status": "BLOCKED_NO_PROMOTED_STRATEGY",
        "sourceCommit": INITIAL_BASELINE_SHA,
        "gateId": ENTRY_GATE_ID,
        "stage5Entered": True,
        "entryAuthorized": False,
        "activationAuthorized": False,
        "runtimeStarted": False,
        "paperApproved": False,
        "testnetApproved": False,
        "liveApproved": False,
    }
    if not isinstance(gate, dict) or any(gate.get(key) != expected for key, expected in required.items()):
        raise ValueError("STAGE5_ENTRY_GATE_CONTRACT_MISMATCH")


def _candidate_lineage() -> list[dict[str, str]]:
    return [
        {
            "strategyId": "derived-mean-reversion-trend-guard-262ffac08c1acf35",
            "specId": "58156d6fd0c244449e58bb362c28732688615fa68a4771e4d26b2187ced1babe",
        },
        {
            "strategyId": "derived-stc-trend-filter-5682c752bef50a0c",
            "specId": "139bf050c03982325ab4450a022744f342520b35e1e8971f44e861b11cf4d527",
        },
        {
            "strategyId": "derived-support-resistance-risk-entry-01ef09c554af0da8",
            "specId": "4acc61095aa516bfb5757a5ff615e0fd2560ee07c30028ff4d2fd6b5b6032750",
        },
        {
            "strategyId": "derived-trend-stochastic-confirmation-ca529176d8c82a01",
            "specId": "9c77fe6bb80c79481707e4820ad1493c28cec61c41e156073fe28e9e78eafec6",
        },
    ]


def build_stage5_evaluation_spec(source_commit: str, entry_gate_raw: bytes) -> dict[str, Any]:
    if not isinstance(source_commit, str) or not _GIT_SHA.fullmatch(source_commit):
        raise ValueError("STAGE5_EVALUATION_SOURCE_COMMIT_INVALID")
    _verify_entry_gate(entry_gate_raw)

    spec: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "stage": "STAGE 5.1",
        "status": "FROZEN_BEFORE_DATA_ACCESS",
        "sourceCommit": source_commit,
        "entryGate": {
            "gateId": ENTRY_GATE_ID,
            "rawSha256": ENTRY_GATE_RAW_SHA256,
            "workflowRunId": ENTRY_GATE_WORKFLOW_RUN_ID,
        },
        "creationInputs": {
            "constitutionVersion": 1,
            "initialBaselineSha": INITIAL_BASELINE_SHA,
            "lockedTestAccessCount": 0,
            "lockedTestOpened": False,
        },
        "evaluationLineage": {
            "stage4A12CandidateManifestRawSha256": "919146d3a73e22f9b3732aa735ff8fab967a2d4f9eb9bb57ce4a3a5d86734899",
            "stage4A12CandidateManifestSourceCommit": "80f12966081e3851424f820dd3428249d5537eb9",
            "stage4A12PromotionReceiptId": "4f8f23a24bd117d21b41872bbcd1788fdf1898d02b42c8a29cab79755a1d149f",
            "stage4A13GovernanceContractId": "1c9219c4738e6e4cd2e507fb50d6032a6d256056941d497b93ef995485510b39",
            "stage4A13ConsumedEvidenceSeedId": "f58c1c6e7378ea341b3cafe39405588858fffa45342d33f8302ae3d40343b153",
            "inheritedConsumedHoldoutWindowCount": 10,
            "inheritedConsumedEvaluationCount": 40,
            "strategyIdChangeResetsConsumption": False,
            "candidates": _candidate_lineage(),
        },
        "searchBudget": {
            "maxResearchRounds": 1,
            "maxCandidatesPerRound": 4,
            "maxPromotedStrategies": 1,
            "lockedTestAccessPerStage5": 1,
            "candidateSource": "ALL_FOUR_STAGE_4A12_CANDIDATES_WITH_LINEAGE",
            "unlimitedSearch": False,
        },
        "universe": {
            "symbols": ["BNB/USDT", "BTC/USDT", "ETH/USDT", "SOL/USDT"],
            "timeframe": "5m",
            "venue": "BINANCE_PUBLIC_MARKET_DATA",
            "marketModel": "UNLEVERED_LINEAR_RESEARCH_PROXY",
            "positionSides": ["long", "short"],
        },
        "ranges": {
            "TRAIN": {"startInclusive": "2025-07-02T00:00:00Z", "endExclusive": "2026-04-01T00:00:00Z"},
            "VALIDATION": {"startInclusive": "2026-04-01T00:00:00Z", "endExclusive": "2026-07-01T00:00:00Z"},
            "LOCKED_TEST": {"startInclusive": "2026-07-01T00:00:00Z", "endExclusive": "2026-07-29T00:00:00Z"},
        },
        "splitContract": {
            "chronological": True,
            "purgeBars": 96,
            "embargoBars": 96,
            "warmupBars": 100,
            "featureLookbackBars": 100,
            "labelHorizonBars": 1,
            "closedBarsOnly": True,
            "nextOpenExecution": True,
            "fitOnTrainOnly": True,
            "validationSelectionOnly": True,
            "lockedTestSelection": False,
            "gapPolicy": "reject",
            "duplicatePolicy": "reject",
            "timezone": "UTC",
        },
        "costModel": {
            "baseline": {
                "feeBpsPerFill": 5.0,
                "halfSpreadBpsPerFill": 1.0,
                "slippageBpsPerFill": 2.0,
                "fundingBpsPer8hAdverse": 1.0,
            },
            "stress": {
                "feeBpsPerFill": 10.0,
                "halfSpreadBpsPerFill": 2.0,
                "slippageBpsPerFill": 5.0,
                "fundingBpsPer8hAdverse": 2.0,
            },
            "latencyBars": 1,
            "leverageAllowed": False,
            "rebatesAllowed": False,
            "fundingPolicy": "SYMMETRIC_ADVERSE_RESEARCH_CHARGE",
        },
        "metrics": [
            "grossReturn", "netReturn", "maximumDrawdown", "sharpe", "sortino",
            "profitFactor", "winRate", "averageWin", "averageLoss", "expectancy",
            "turnover", "tradeCount", "exposure", "fees", "spreadCost",
            "slippageCost", "fundingCost", "mfe", "mae", "rMultiple",
        ],
        "validationGate": {
            "aggregateTradeCountMin": 120,
            "eachAssetTradeCountMin": 20,
            "medianNetReturnMinExclusive": 0.0,
            "positiveAssetsMin": 3,
            "eachAssetMaximumDrawdownMax": 0.20,
            "aggregateProfitFactorMin": 1.10,
            "aggregateSharpeMin": 0.50,
            "aggregateSortinoMin": 0.70,
            "stressedMedianNetReturnMin": -0.02,
        },
        "lockedTestGate": {
            "accessCountExactly": 1,
            "testedCandidateCountExactly": 1,
            "aggregateTradeCountMin": 40,
            "eachAssetTradeCountMin": 5,
            "medianNetReturnMinExclusive": 0.0,
            "positiveAssetsMin": 3,
            "eachAssetMaximumDrawdownMax": 0.15,
            "aggregateProfitFactorMin": 1.05,
            "aggregateSharpeMin": 0.25,
            "stressedMedianNetReturnMin": 0.0,
            "noPostTestMutation": True,
        },
        "robustness": {
            "parameterPerturbations": [-0.10, -0.05, 0.05, 0.10],
            "minimumNonNegativePerturbations": 3,
            "maximumSingleAssetProfitShare": 0.60,
            "maximumSingleTradeProfitShare": 0.20,
            "overfitRiskAllowed": ["LOW", "MEDIUM"],
            "deterministicReplayRequired": True,
        },
        "ranking": {
            "evidencePhases": ["TRAIN", "VALIDATION"],
            "lockedTestMayChangeRanking": False,
            "reportAllCandidatesAndFailures": True,
            "resultBasedThresholdChangesAllowed": False,
            "postResultAssetOrTimeExclusionAllowed": False,
            "postResultCandidateExpansionAllowed": False,
        },
        "safety": {
            "offlineOnly": True,
            "paperTestnetLiveCalls": 0,
            "activationAuthorized": False,
            "runtimeStarted": False,
            "paperApproved": False,
            "testnetApproved": False,
            "liveApproved": False,
        },
    }
    spec["evaluationSpecId"] = canonical_sha256(spec)
    return spec


def verify_stage5_evaluation_spec(
    spec: Mapping[str, Any],
    source_commit: str,
    entry_gate_raw: bytes,
) -> None:
    if not isinstance(spec, Mapping):
        raise ValueError("STAGE5_EVALUATION_SPEC_NOT_MAPPING")
    expected = build_stage5_evaluation_spec(source_commit, entry_gate_raw)
    try:
        actual_bytes = canonical_json_bytes(spec)
    except (TypeError, ValueError) as error:
        raise ValueError("STAGE5_EVALUATION_SPEC_NOT_CANONICAL") from error
    if actual_bytes != canonical_json_bytes(expected):
        raise ValueError("STAGE5_EVALUATION_SPEC_MISMATCH")
