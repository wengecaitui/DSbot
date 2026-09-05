"""Closed Phase 9D interchange validation and deterministic JSON helpers."""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from typing import Any

INTERCHANGE_VERSION = "DSBOT_RESEARCH_STORAGE_INTERCHANGE_V1"
STORAGE_SCHEMA_VERSION = "DSBOT_RESEARCH_STORAGE_BUNDLE_V1"
PAYLOAD_TAGS = {
    "NULL", "UNDEFINED", "BOOLEAN", "STRING", "NUMBER", "NEGATIVE_ZERO",
    "NAN", "POSITIVE_INFINITY", "NEGATIVE_INFINITY", "BIGINT", "ARRAY", "OBJECT",
}
TIME_EVIDENCE_STATES = {"KNOWN", "DOCUMENTED_RULE_UNMATERIALIZED", "UNKNOWN", "NOT_APPLICABLE"}
PRESENCE_STATES = {"MISSING", "NULL", "VALUE"}
SCALAR_LOGICAL_TYPES = {"BOOLEAN", "INT64", "FLOAT64", "STRING", "DATE", "TIMESTAMP_UTC"}
SIMPLE_UNITS = {"UNITLESS", "SHARES", "COUNT", "RATIO", "PERCENT", "BASIS_POINTS"}
SEMANTIC_ROLES = {"MEASURE", "IDENTIFIER", "TIMESTAMP", "LABEL", "METADATA"}
EVENT_REQUIREMENTS = {"RECORD_EVENT_TIME_SUFFICIENT", "FIELD_LEVEL_REQUIRED", "NOT_APPLICABLE"}
AVAILABILITY_REQUIREMENTS = {"RECORD_AVAILABLE_AT_SUFFICIENT", "FIELD_LEVEL_REQUIRED", "UNKNOWN"}
HISTORICAL_POLICIES = {"REQUIRES_PROVABLE_AVAILABILITY", "FORBIDDEN_AS_DECISION_INPUT"}
RESEARCH_USES = {
    "FACTOR_INPUT", "LABEL", "RESEARCH_VALUATION", "UNIVERSE_FILTER",
    "RESEARCH_EXECUTION_MODEL_INPUT", "JOIN_KEY", "DISPLAY", "QUALITY_CONTROL",
}
SAFE_INTEGER_MAX = 9007199254740991
AVAILABLE_AT_AUTHORITIES = {"PROVIDER_FIELD", "DOCUMENTED_RULE", "UNKNOWN"}
FIXED_ARTIFACTS = (
    "raw_records.parquet",
    "canonical_records.parquet",
    "canonical_fields.parquet",
    "canonical_schema.json",
)
MANIFEST_NAME = "bundle.manifest.json"
COMMIT_MARKER_NAME = "COMMITTED"
BUNDLE_ID_RE = re.compile(r"^[0-9a-f]{64}$")
IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$")


class ResearchStorageError(ValueError):
    """A fail-closed Phase 9D contract or bundle violation."""


def fail(reason: str) -> None:
    raise ResearchStorageError(f"PHASE_9D_RESEARCH_STORAGE_INVALID:{reason}")


def canonical_json_bytes(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ResearchStorageError("PHASE_9D_RESEARCH_STORAGE_INVALID:NON_CANONICAL_JSON") from exc


def _exact_keys(value: dict[str, Any], required: set[str], optional: set[str] | None = None, reason: str = "FIELDS") -> None:
    allowed = required | (optional or set())
    if not required.issubset(value) or set(value) - allowed:
        fail(reason)


def _text(value: Any, reason: str, *, nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if not isinstance(value, str):
        fail(reason)


def _timestamp(value: Any, reason: str, *, nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if not isinstance(value, str) or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z", value) is None:
        fail(reason)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ResearchStorageError(f"PHASE_9D_RESEARCH_STORAGE_INVALID:{reason}") from exc
    if parsed.tzinfo != timezone.utc:
        fail(reason)


def _logical_type(value: Any, reason: str) -> str:
    if isinstance(value, str) and value in SCALAR_LOGICAL_TYPES:
        return value
    if isinstance(value, dict):
        _exact_keys(value, {"kind", "precision", "scale"}, reason=reason)
        if value["kind"] == "DECIMAL" and type(value["precision"]) is int and type(value["scale"]) is int and 0 <= value["scale"] <= value["precision"] and value["precision"] >= 1:
            return "DECIMAL"
    fail(reason)


def _unit(value: Any, reason: str) -> None:
    if isinstance(value, str) and value in SIMPLE_UNITS:
        return
    if not isinstance(value, dict):
        fail(reason)
    if value.get("kind") == "CURRENCY":
        _exact_keys(value, {"kind", "currencyFieldId"}, reason=reason)
        _text(value["currencyFieldId"], reason)
        return
    if value.get("kind") == "OTHER":
        _exact_keys(value, {"kind", "description"}, reason=reason)
        _text(value["description"], reason)
        return
    fail(reason)


def _canonical_value(value: Any, logical: Any, reason: str) -> None:
    name = _logical_type(logical, reason)
    if name == "BOOLEAN" and type(value) is bool:
        return
    if name == "INT64" and type(value) is int and abs(value) <= SAFE_INTEGER_MAX:
        return
    if name == "FLOAT64" and type(value) in {int, float} and math.isfinite(value):
        return
    if name == "STRING" and isinstance(value, str):
        return
    if name == "DATE" and isinstance(value, str) and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        try:
            if datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d") == value:
                return
        except ValueError:
            pass
    if name == "TIMESTAMP_UTC":
        _timestamp(value, reason)
        return
    if name == "DECIMAL" and isinstance(value, str) and re.fullmatch(r"-?(0|[1-9][0-9]*)\.[0-9]+", value):
        unsigned = value[1:] if value.startswith("-") else value
        integer, fraction = unsigned.split(".")
        if len(fraction) == logical["scale"] and len(integer + fraction) <= logical["precision"]:
            return
    fail(reason)


def _payload_node(node: Any, path: str = "PAYLOAD") -> None:
    if not isinstance(node, dict) or not isinstance(node.get("tag"), str) or node["tag"] not in PAYLOAD_TAGS:
        fail(f"{path}_TAG")
    tag = node["tag"]
    if tag in {"NULL", "UNDEFINED", "NEGATIVE_ZERO", "NAN", "POSITIVE_INFINITY", "NEGATIVE_INFINITY"}:
        _exact_keys(node, {"tag"}, reason=f"{path}_FIELDS")
    elif tag == "BOOLEAN":
        _exact_keys(node, {"tag", "value"}, reason=f"{path}_FIELDS")
        if type(node["value"]) is not bool:
            fail(f"{path}_BOOLEAN")
    elif tag == "STRING":
        _exact_keys(node, {"tag", "value"}, reason=f"{path}_FIELDS")
        _text(node["value"], f"{path}_STRING")
    elif tag == "NUMBER":
        _exact_keys(node, {"tag", "value"}, reason=f"{path}_FIELDS")
        if type(node["value"]) not in {int, float} or not math.isfinite(node["value"]) or node["value"] == 0 and math.copysign(1, node["value"]) < 0:
            fail(f"{path}_NUMBER")
    elif tag == "BIGINT":
        _exact_keys(node, {"tag", "value"}, reason=f"{path}_FIELDS")
        if not isinstance(node["value"], str) or re.fullmatch(r"-?(0|[1-9][0-9]*)", node["value"]) is None:
            fail(f"{path}_BIGINT")
    elif tag == "ARRAY":
        _exact_keys(node, {"tag", "items"}, reason=f"{path}_FIELDS")
        if not isinstance(node["items"], list):
            fail(f"{path}_ARRAY")
        for index, item in enumerate(node["items"]):
            _payload_node(item, f"{path}_{index}")
    elif tag == "OBJECT":
        _exact_keys(node, {"tag", "entries"}, reason=f"{path}_FIELDS")
        if not isinstance(node["entries"], list):
            fail(f"{path}_OBJECT")
        previous: str | None = None
        for index, entry in enumerate(node["entries"]):
            if not isinstance(entry, list) or len(entry) != 2 or not isinstance(entry[0], str):
                fail(f"{path}_ENTRY_{index}")
            if previous is not None and entry[0] <= previous:
                fail(f"{path}_ENTRY_ORDER")
            previous = entry[0]
            _payload_node(entry[1], f"{path}_{index}")


def _time_evidence(value: Any, reason: str) -> None:
    if not isinstance(value, dict) or value.get("state") not in TIME_EVIDENCE_STATES:
        fail(reason)
    state = value["state"]
    if state == "KNOWN":
        _exact_keys(value, {"state", "value", "source"}, reason=reason)
        _timestamp(value["value"], reason)
        if value["source"] not in {"RECORD_ENVELOPE", "SOURCE_PAYLOAD_PATH"}:
            fail(reason)
    elif state == "DOCUMENTED_RULE_UNMATERIALIZED":
        _exact_keys(value, {"state", "rule"}, reason=reason)
        _text(value["rule"], reason)
    else:
        _exact_keys(value, {"state"}, reason=reason)


def _field(value: Any, index: int) -> None:
    if not isinstance(value, dict):
        fail(f"FIELD_{index}_OBJECT")
    required = {
        "fieldId", "logicalType", "unit", "semanticRole", "eventTimeRequirement",
        "availabilityRequirement", "historicalDecisionPolicy", "researchUsePolicy",
        "presence", "eventTimeEvidence", "availabilityEvidence",
    }
    _exact_keys(value, required, reason=f"FIELD_{index}_FIELDS")
    _text(value["fieldId"], f"FIELD_{index}_ID")
    _logical_type(value["logicalType"], f"FIELD_{index}_LOGICAL_TYPE")
    _unit(value["unit"], f"FIELD_{index}_UNIT")
    if value["semanticRole"] not in SEMANTIC_ROLES:
        fail(f"FIELD_{index}_SEMANTIC_ROLE")
    if value["eventTimeRequirement"] not in EVENT_REQUIREMENTS:
        fail(f"FIELD_{index}_EVENT_REQUIREMENT")
    if value["availabilityRequirement"] not in AVAILABILITY_REQUIREMENTS:
        fail(f"FIELD_{index}_AVAILABILITY_REQUIREMENT")
    if value["historicalDecisionPolicy"] not in HISTORICAL_POLICIES:
        fail(f"FIELD_{index}_HISTORICAL_POLICY")
    if not isinstance(value["researchUsePolicy"], dict) or set(value["researchUsePolicy"]) != RESEARCH_USES:
        fail(f"FIELD_{index}_POLICY")
    if any(decision not in {"ALLOW", "DENY"} for decision in value["researchUsePolicy"].values()):
        fail(f"FIELD_{index}_POLICY_VALUE")
    presence = value["presence"]
    if not isinstance(presence, dict) or presence.get("state") not in PRESENCE_STATES:
        fail(f"FIELD_{index}_PRESENCE")
    if presence["state"] == "VALUE":
        _exact_keys(presence, {"state", "value"}, reason=f"FIELD_{index}_PRESENCE_FIELDS")
        _canonical_value(presence["value"], value["logicalType"], f"FIELD_{index}_VALUE")
    else:
        _exact_keys(presence, {"state"}, reason=f"FIELD_{index}_PRESENCE_FIELDS")
    _time_evidence(value["eventTimeEvidence"], f"FIELD_{index}_EVENT_EVIDENCE")
    _time_evidence(value["availabilityEvidence"], f"FIELD_{index}_AVAILABILITY_EVIDENCE")


def validate_interchange(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail("ROOT")
    _exact_keys(value, {"storageInterchangeVersion", "productionAuthority", "rawRecords", "canonicalDataset"}, reason="ROOT_FIELDS")
    if value["storageInterchangeVersion"] != INTERCHANGE_VERSION:
        fail("INTERCHANGE_VERSION")
    if value["productionAuthority"] is not False:
        fail("PRODUCTION_AUTHORITY")
    raw_records = value["rawRecords"]
    dataset = value["canonicalDataset"]
    if not isinstance(raw_records, list) or not isinstance(dataset, dict):
        fail("DATASETS")
    dataset_required = {
        "schemaVersion", "dictionaryId", "dictionaryVersion", "bindingId", "bindingVersion",
        "providerId", "adapterId", "sourceDatasetRef", "records", "productionAuthority",
    }
    _exact_keys(dataset, dataset_required, reason="CANONICAL_DATASET_FIELDS")
    if dataset["schemaVersion"] != "1.0.0" or dataset["productionAuthority"] is not False or not isinstance(dataset["records"], list):
        fail("CANONICAL_DATASET_HEADER")
    for key in ("dictionaryId", "dictionaryVersion", "bindingId", "bindingVersion", "providerId", "adapterId", "sourceDatasetRef"):
        _text(dataset[key], f"DATASET_{key}")
    if len(raw_records) != len(dataset["records"]):
        fail("RECORD_COUNT_MISMATCH")
    source_ids: set[str] = set()
    expected_field_semantics: list[bytes] | None = None
    for index, (raw, canonical) in enumerate(zip(raw_records, dataset["records"], strict=True)):
        if not isinstance(raw, dict) or not isinstance(canonical, dict):
            fail(f"RECORD_{index}_OBJECT")
        raw_required = {
            "providerId", "adapterId", "adapterVersion", "sourceDatasetRef", "sourceRecordId",
            "eventTime", "availableAt", "availableAtAuthority", "ingestedAt", "payload", "payloadHash",
            "manifestVersion", "manifestReference", "requestId", "sourceProvenanceRef",
        }
        _exact_keys(raw, raw_required, {"sourceRevision"}, f"RAW_{index}_FIELDS")
        for key in raw_required - {"availableAt", "payload"}:
            _text(raw[key], f"RAW_{index}_{key}")
        for key in ("providerId", "adapterId", "adapterVersion", "sourceDatasetRef", "sourceRecordId", "manifestVersion", "manifestReference", "requestId", "sourceProvenanceRef"):
            if IDENTIFIER_RE.fullmatch(raw[key]) is None:
                fail(f"RAW_{index}_{key}_IDENTIFIER")
        _timestamp(raw["eventTime"], f"RAW_{index}_eventTime")
        _timestamp(raw["availableAt"], f"RAW_{index}_availableAt", nullable=True)
        _timestamp(raw["ingestedAt"], f"RAW_{index}_ingestedAt")
        _payload_node(raw["payload"], f"RAW_{index}_PAYLOAD")
        if raw["availableAtAuthority"] not in AVAILABLE_AT_AUTHORITIES:
            fail(f"RAW_{index}_AVAILABLE_AT_AUTHORITY")
        if raw["availableAtAuthority"] == "UNKNOWN" and raw["availableAt"] is not None:
            fail(f"RAW_{index}_UNKNOWN_AVAILABLE_AT")
        if BUNDLE_ID_RE.fullmatch(raw["payloadHash"]) is None:
            fail(f"RAW_{index}_PAYLOAD_HASH")
        if "sourceRevision" in raw:
            revision = raw["sourceRevision"]
            if not isinstance(revision, dict):
                fail(f"RAW_{index}_REVISION")
            _exact_keys(revision, {"revisionId"}, {"observedAt"}, f"RAW_{index}_REVISION_FIELDS")
            _text(revision["revisionId"], f"RAW_{index}_REVISION_ID")
            if "observedAt" in revision:
                _timestamp(revision["observedAt"], f"RAW_{index}_REVISION_OBSERVED")
        canonical_required = {
            "sourceRecordId", "adapterVersion", "eventTime", "availableAt", "availableAtAuthority",
            "ingestedAt", "payloadHash", "manifestVersion", "manifestReference", "requestId",
            "sourceProvenanceRef", "fields",
        }
        _exact_keys(canonical, canonical_required, {"sourceRevision"}, f"CANONICAL_{index}_FIELDS")
        if canonical["sourceRecordId"] != raw["sourceRecordId"]:
            fail("RECORD_ORDER_MISMATCH")
        if raw["sourceRecordId"] in source_ids:
            fail("DUPLICATE_SOURCE_RECORD_ID")
        source_ids.add(raw["sourceRecordId"])
        for key in canonical_required - {"availableAt", "fields"}:
            _text(canonical[key], f"CANONICAL_{index}_{key}")
        _timestamp(canonical["eventTime"], f"CANONICAL_{index}_eventTime")
        _timestamp(canonical["availableAt"], f"CANONICAL_{index}_availableAt", nullable=True)
        _timestamp(canonical["ingestedAt"], f"CANONICAL_{index}_ingestedAt")
        if canonical["availableAtAuthority"] not in AVAILABLE_AT_AUTHORITIES:
            fail(f"CANONICAL_{index}_AVAILABLE_AT_AUTHORITY")
        if canonical["availableAtAuthority"] == "UNKNOWN" and canonical["availableAt"] is not None:
            fail(f"CANONICAL_{index}_UNKNOWN_AVAILABLE_AT")
        if canonical.get("sourceRevision") != raw.get("sourceRevision"):
            fail("SOURCE_REVISION_MISMATCH")
        for raw_key, canonical_key in (
            ("adapterVersion", "adapterVersion"), ("eventTime", "eventTime"),
            ("availableAt", "availableAt"), ("availableAtAuthority", "availableAtAuthority"),
            ("ingestedAt", "ingestedAt"), ("payloadHash", "payloadHash"),
            ("manifestVersion", "manifestVersion"), ("manifestReference", "manifestReference"),
            ("requestId", "requestId"), ("sourceProvenanceRef", "sourceProvenanceRef"),
        ):
            if raw[raw_key] != canonical[canonical_key]:
                fail("RAW_CANONICAL_PROVENANCE_MISMATCH")
        if raw["providerId"] != dataset["providerId"] or raw["adapterId"] != dataset["adapterId"] or raw["sourceDatasetRef"] != dataset["sourceDatasetRef"]:
            fail("RAW_DATASET_IDENTITY_MISMATCH")
        if not isinstance(canonical["fields"], list):
            fail(f"CANONICAL_{index}_FIELD_ARRAY")
        for field_index, field in enumerate(canonical["fields"]):
            _field(field, field_index)
        semantics = [canonical_json_bytes({key: field[key] for key in (
            "fieldId", "logicalType", "unit", "semanticRole", "eventTimeRequirement",
            "availabilityRequirement", "historicalDecisionPolicy", "researchUsePolicy",
        )}) for field in canonical["fields"]]
        if expected_field_semantics is None:
            expected_field_semantics = semantics
        elif semantics != expected_field_semantics:
            fail("FIELD_SEMANTICS_DRIFT")
    return value


def field_semantics(dataset: dict[str, Any]) -> list[dict[str, Any]]:
    records = dataset["records"]
    if not records:
        return []
    return [{key: field[key] for key in (
        "fieldId", "logicalType", "unit", "semanticRole", "eventTimeRequirement",
        "availabilityRequirement", "historicalDecisionPolicy", "researchUsePolicy",
    )} for field in records[0]["fields"]]
