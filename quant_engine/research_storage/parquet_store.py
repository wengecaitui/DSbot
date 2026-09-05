"""Immutable Parquet truth with fail-closed validation and read-only views."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import uuid
from typing import Any

import duckdb
import polars as pl

from .schema import (
    BUNDLE_ID_RE,
    COMMIT_MARKER_NAME,
    FIXED_ARTIFACTS,
    INTERCHANGE_VERSION,
    MANIFEST_NAME,
    STORAGE_SCHEMA_VERSION,
    ResearchStorageError,
    canonical_json_bytes,
    fail,
    field_semantics,
    validate_interchange,
)

_EXPECTED_BUNDLE_FILES = set(FIXED_ARTIFACTS) | {MANIFEST_NAME, COMMIT_MARKER_NAME}


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_reparse(stat_result: os.stat_result) -> bool:
    return bool(getattr(stat_result, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def _assert_no_link_or_reparse(path: Path) -> None:
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        if not current.exists():
            continue
        result = current.lstat()
        if stat.S_ISLNK(result.st_mode) or _is_reparse(result):
            fail("SYMLINK_OR_REPARSE_POINT")


def _validated_root(storage_root: str | os.PathLike[str]) -> Path:
    raw = os.fspath(storage_root)
    if not isinstance(raw, str) or "://" in raw or raw.startswith(("\\\\", "//")):
        fail("ROOT_NOT_LOCAL")
    candidate = Path(raw)
    if ".." in candidate.parts:
        fail("ROOT_TRAVERSAL")
    if not candidate.is_absolute() or not candidate.exists() or not candidate.is_dir():
        fail("ROOT_MUST_BE_EXISTING_ABSOLUTE_DIRECTORY")
    _assert_no_link_or_reparse(candidate)
    return candidate.resolve(strict=True)


def _contained(root: Path, path: Path) -> Path:
    resolved_parent = path.parent.resolve(strict=True)
    if resolved_parent != root and root not in resolved_parent.parents:
        fail("PATH_ESCAPE")
    _assert_no_link_or_reparse(resolved_parent)
    if path.exists():
        _assert_no_link_or_reparse(path)
    return path


def _bundle_path(root: Path, bundle_id: str) -> Path:
    if BUNDLE_ID_RE.fullmatch(bundle_id) is None:
        fail("BUNDLE_ID")
    return _contained(root, root / bundle_id)


def _write_bytes(path: Path, value: bytes) -> None:
    with path.open("xb") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())


def _json(value: Any) -> str:
    return canonical_json_bytes(value).decode("utf-8")


def _raw_rows(interchange: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for order, record in enumerate(interchange["rawRecords"]):
        revision = record.get("sourceRevision") or {}
        rows.append({
            "record_order": order,
            "provider_id": record["providerId"], "adapter_id": record["adapterId"],
            "adapter_version": record["adapterVersion"], "source_dataset_ref": record["sourceDatasetRef"],
            "source_record_id": record["sourceRecordId"], "event_time": record["eventTime"],
            "available_at": record["availableAt"], "available_at_authority": record["availableAtAuthority"],
            "ingested_at": record["ingestedAt"], "payload_codec_json": _json(record["payload"]),
            "payload_hash": record["payloadHash"], "manifest_version": record["manifestVersion"],
            "manifest_reference": record["manifestReference"], "request_id": record["requestId"],
            "source_provenance_ref": record["sourceProvenanceRef"],
            "source_revision_id": revision.get("revisionId"),
            "source_revision_observed_at": revision.get("observedAt"),
        })
    return rows


def _canonical_record_rows(interchange: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for order, record in enumerate(interchange["canonicalDataset"]["records"]):
        revision = record.get("sourceRevision") or {}
        rows.append({
            "record_order": order, "source_record_id": record["sourceRecordId"],
            "adapter_version": record["adapterVersion"], "event_time": record["eventTime"],
            "available_at": record["availableAt"], "available_at_authority": record["availableAtAuthority"],
            "ingested_at": record["ingestedAt"], "payload_hash": record["payloadHash"],
            "manifest_version": record["manifestVersion"], "manifest_reference": record["manifestReference"],
            "request_id": record["requestId"], "source_provenance_ref": record["sourceProvenanceRef"],
            "source_revision_id": revision.get("revisionId"),
            "source_revision_observed_at": revision.get("observedAt"),
        })
    return rows


def _canonical_field_rows(interchange: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for record_order, record in enumerate(interchange["canonicalDataset"]["records"]):
        for field_order, field in enumerate(record["fields"]):
            presence = field["presence"]
            value = presence.get("value")
            logical = field["logicalType"]
            logical_name = logical if isinstance(logical, str) else "DECIMAL"
            rows.append({
                "record_order": record_order, "field_order": field_order, "field_id": field["fieldId"],
                "logical_type_json": _json(logical), "unit_json": _json(field["unit"]),
                "semantic_role": field["semanticRole"], "event_time_requirement": field["eventTimeRequirement"],
                "availability_requirement": field["availabilityRequirement"],
                "historical_decision_policy": field["historicalDecisionPolicy"],
                "research_use_policy_json": _json(field["researchUsePolicy"]),
                "presence_state": presence["state"],
                "value_boolean": value if presence["state"] == "VALUE" and logical_name == "BOOLEAN" else None,
                "value_int64": value if presence["state"] == "VALUE" and logical_name == "INT64" else None,
                "value_float64": value if presence["state"] == "VALUE" and logical_name == "FLOAT64" else None,
                "value_string": value if presence["state"] == "VALUE" and logical_name in {"STRING", "DATE", "TIMESTAMP_UTC", "DECIMAL"} else None,
                "event_time_evidence_json": _json(field["eventTimeEvidence"]),
                "availability_evidence_json": _json(field["availabilityEvidence"]),
            })
    return rows


_RAW_SCHEMA = {
    "record_order": pl.UInt32, "provider_id": pl.String, "adapter_id": pl.String,
    "adapter_version": pl.String, "source_dataset_ref": pl.String, "source_record_id": pl.String,
    "event_time": pl.String, "available_at": pl.String, "available_at_authority": pl.String,
    "ingested_at": pl.String, "payload_codec_json": pl.String, "payload_hash": pl.String,
    "manifest_version": pl.String, "manifest_reference": pl.String, "request_id": pl.String,
    "source_provenance_ref": pl.String, "source_revision_id": pl.String,
    "source_revision_observed_at": pl.String,
}
_RECORD_SCHEMA = {key: value for key, value in _RAW_SCHEMA.items() if key not in {"provider_id", "adapter_id", "source_dataset_ref", "payload_codec_json"}}
_FIELD_SCHEMA = {
    "record_order": pl.UInt32, "field_order": pl.UInt32, "field_id": pl.String,
    "logical_type_json": pl.String, "unit_json": pl.String, "semantic_role": pl.String,
    "event_time_requirement": pl.String, "availability_requirement": pl.String,
    "historical_decision_policy": pl.String, "research_use_policy_json": pl.String,
    "presence_state": pl.String, "value_boolean": pl.Boolean, "value_int64": pl.Int64,
    "value_float64": pl.Float64, "value_string": pl.String,
    "event_time_evidence_json": pl.String, "availability_evidence_json": pl.String,
}


def _write_parquet(path: Path, rows: list[dict[str, Any]], schema: dict[str, pl.DataType]) -> None:
    frame = pl.DataFrame(rows, schema=schema)
    with path.open("xb") as handle:
        frame.write_parquet(handle, compression="zstd", statistics=True)
        handle.flush()
        os.fsync(handle.fileno())


def _schema_artifact(interchange: dict[str, Any]) -> dict[str, Any]:
    dataset = interchange["canonicalDataset"]
    return {
        "storageSchemaVersion": STORAGE_SCHEMA_VERSION,
        "storageInterchangeVersion": INTERCHANGE_VERSION,
        "productionAuthority": False,
        "dictionaryId": dataset["dictionaryId"], "dictionaryVersion": dataset["dictionaryVersion"],
        "bindingId": dataset["bindingId"], "bindingVersion": dataset["bindingVersion"],
        "providerId": dataset["providerId"], "adapterId": dataset["adapterId"],
        "sourceDatasetRef": dataset["sourceDatasetRef"],
        "orderedFieldSemantics": field_semantics(dataset),
    }


def _manifest(interchange: dict[str, Any], bundle_id: str, stage: Path) -> dict[str, Any]:
    dataset = interchange["canonicalDataset"]
    files = [{"path": name, "byteLength": (stage / name).stat().st_size, "sha256": _sha256_file(stage / name)} for name in FIXED_ARTIFACTS]
    return {
        "storageSchemaVersion": STORAGE_SCHEMA_VERSION, "bundleId": bundle_id,
        "productionAuthority": False,
        "dictionaryId": dataset["dictionaryId"], "dictionaryVersion": dataset["dictionaryVersion"],
        "bindingId": dataset["bindingId"], "bindingVersion": dataset["bindingVersion"],
        "providerId": dataset["providerId"], "adapterId": dataset["adapterId"],
        "sourceDatasetRef": dataset["sourceDatasetRef"],
        "rawRecordCount": len(interchange["rawRecords"]),
        "canonicalRecordCount": len(dataset["records"]),
        "canonicalFieldCount": sum(len(record["fields"]) for record in dataset["records"]),
        "files": files,
        "formatEngines": {"duckdb": duckdb.__version__, "polars": pl.__version__, "parquetWriter": f"polars {pl.__version__}"},
    }


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ResearchStorageError(f"PHASE_9D_RESEARCH_STORAGE_INVALID:MALFORMED_JSON:{path.name}") from exc


def _validate_directory(
    bundle: Path,
    require_committed: bool = True,
    expected_bundle_id: str | None = None,
) -> dict[str, Any]:
    _assert_no_link_or_reparse(bundle)
    actual = {entry.name for entry in bundle.iterdir()}
    expected = _EXPECTED_BUNDLE_FILES if require_committed else _EXPECTED_BUNDLE_FILES - {COMMIT_MARKER_NAME}
    if actual != expected:
        fail("UNDECLARED_OR_MISSING_ARTIFACT")
    for entry in bundle.iterdir():
        _assert_no_link_or_reparse(entry)
        if not entry.is_file():
            fail("ARTIFACT_NOT_REGULAR_FILE")
    manifest_path = bundle / MANIFEST_NAME
    manifest = _read_json(manifest_path)
    if not isinstance(manifest, dict) or manifest.get("storageSchemaVersion") != STORAGE_SCHEMA_VERSION:
        fail("UNSUPPORTED_STORAGE_SCHEMA")
    expected_manifest_fields = {
        "storageSchemaVersion", "bundleId", "productionAuthority", "dictionaryId", "dictionaryVersion",
        "bindingId", "bindingVersion", "providerId", "adapterId", "sourceDatasetRef",
        "rawRecordCount", "canonicalRecordCount", "canonicalFieldCount", "files", "formatEngines",
    }
    if set(manifest) != expected_manifest_fields:
        fail("MANIFEST_FIELDS")
    bundle_id = manifest.get("bundleId")
    expected_identity = bundle.name if expected_bundle_id is None else expected_bundle_id
    if bundle_id != expected_identity or not isinstance(bundle_id, str) or BUNDLE_ID_RE.fullmatch(bundle_id) is None:
        fail("MANIFEST_BUNDLE_ID")
    if manifest.get("productionAuthority") is not False:
        fail("MANIFEST_PRODUCTION_AUTHORITY")
    for key in ("dictionaryId", "dictionaryVersion", "bindingId", "bindingVersion", "providerId", "adapterId", "sourceDatasetRef"):
        if not isinstance(manifest[key], str):
            fail("MANIFEST_IDENTITY")
    for key in ("rawRecordCount", "canonicalRecordCount", "canonicalFieldCount"):
        if type(manifest[key]) is not int or manifest[key] < 0:
            fail("MANIFEST_COUNT")
    engines = manifest["formatEngines"]
    if not isinstance(engines, dict) or set(engines) != {"duckdb", "polars", "parquetWriter"} or not all(isinstance(item, str) for item in engines.values()):
        fail("MANIFEST_ENGINES")
    files = manifest.get("files")
    if not isinstance(files, list) or [item.get("path") for item in files if isinstance(item, dict)] != list(FIXED_ARTIFACTS):
        fail("MANIFEST_FILES")
    for item in files:
        if set(item) != {"path", "byteLength", "sha256"}:
            fail("MANIFEST_FILE_FIELDS")
        artifact = bundle / item["path"]
        _contained(bundle, artifact)
        if not artifact.is_file() or artifact.stat().st_size != item["byteLength"]:
            fail("ARTIFACT_BYTE_LENGTH")
        if _sha256_file(artifact) != item["sha256"]:
            fail("ARTIFACT_SHA256")
    schema = _read_json(bundle / "canonical_schema.json")
    expected_schema_fields = {
        "storageSchemaVersion", "storageInterchangeVersion", "productionAuthority",
        "dictionaryId", "dictionaryVersion", "bindingId", "bindingVersion",
        "providerId", "adapterId", "sourceDatasetRef", "orderedFieldSemantics",
    }
    if (
        not isinstance(schema, dict) or set(schema) != expected_schema_fields
        or schema.get("storageSchemaVersion") != STORAGE_SCHEMA_VERSION
        or schema.get("storageInterchangeVersion") != INTERCHANGE_VERSION
        or schema.get("productionAuthority") is not False
        or not isinstance(schema.get("orderedFieldSemantics"), list)
    ):
        fail("MALFORMED_SCHEMA")
    if require_committed:
        receipt = _read_json(bundle / COMMIT_MARKER_NAME)
        expected_receipt = {
            "bundleId": bundle_id,
            "manifestSha256": _sha256_file(manifest_path),
            "storageSchemaVersion": STORAGE_SCHEMA_VERSION,
        }
        if receipt != expected_receipt:
            fail("COMMIT_RECEIPT")
    return manifest


def validate_research_storage_bundle(storage_root: str | os.PathLike[str], bundle_id: str) -> dict[str, Any]:
    root = _validated_root(storage_root)
    bundle = _bundle_path(root, bundle_id)
    if not bundle.is_dir():
        fail("BUNDLE_NOT_FOUND")
    return _validate_directory(bundle)


def _read_rows(path: Path) -> list[dict[str, Any]]:
    try:
        return pl.read_parquet(path).to_dicts()
    except Exception as exc:
        raise ResearchStorageError(f"PHASE_9D_RESEARCH_STORAGE_INVALID:PARQUET_READ:{path.name}") from exc


def _load_validated(bundle: Path) -> dict[str, Any]:
    manifest = _validate_directory(bundle)
    schema = _read_json(bundle / "canonical_schema.json")
    raw_rows = _read_rows(bundle / "raw_records.parquet")
    record_rows = _read_rows(bundle / "canonical_records.parquet")
    field_rows = _read_rows(bundle / "canonical_fields.parquet")
    if len(raw_rows) != manifest["rawRecordCount"] or len(record_rows) != manifest["canonicalRecordCount"] or len(field_rows) != manifest["canonicalFieldCount"]:
        fail("MANIFEST_COUNT_MISMATCH")
    if [row["record_order"] for row in raw_rows] != list(range(len(raw_rows))):
        fail("RAW_RECORD_ORDER")
    if [row["record_order"] for row in record_rows] != list(range(len(record_rows))):
        fail("CANONICAL_RECORD_ORDER")
    raw_records = []
    for row in raw_rows:
        record = {
            "providerId": row["provider_id"], "adapterId": row["adapter_id"],
            "adapterVersion": row["adapter_version"], "sourceDatasetRef": row["source_dataset_ref"],
            "sourceRecordId": row["source_record_id"], "eventTime": row["event_time"],
            "availableAt": row["available_at"], "availableAtAuthority": row["available_at_authority"],
            "ingestedAt": row["ingested_at"], "payload": json.loads(row["payload_codec_json"]),
            "payloadHash": row["payload_hash"], "manifestVersion": row["manifest_version"],
            "manifestReference": row["manifest_reference"], "requestId": row["request_id"],
            "sourceProvenanceRef": row["source_provenance_ref"],
        }
        if row["source_revision_id"] is not None:
            record["sourceRevision"] = {"revisionId": row["source_revision_id"]}
            if row["source_revision_observed_at"] is not None:
                record["sourceRevision"]["observedAt"] = row["source_revision_observed_at"]
        raw_records.append(record)
    fields_by_record: dict[int, list[dict[str, Any]]] = {index: [] for index in range(len(record_rows))}
    expected_pair = [(record_order, field_order) for record_order, record in enumerate(record_rows) for field_order in range(len(schema["orderedFieldSemantics"]))]
    actual_pair = [(row["record_order"], row["field_order"]) for row in field_rows]
    if actual_pair != expected_pair:
        fail("CANONICAL_FIELD_ORDER")
    for row in field_rows:
        logical = json.loads(row["logical_type_json"])
        logical_name = logical if isinstance(logical, str) else "DECIMAL"
        presence: dict[str, Any] = {"state": row["presence_state"]}
        if row["presence_state"] == "VALUE":
            column = {"BOOLEAN": "value_boolean", "INT64": "value_int64", "FLOAT64": "value_float64"}.get(logical_name, "value_string")
            presence["value"] = row[column]
        fields_by_record[row["record_order"]].append({
            "fieldId": row["field_id"], "logicalType": logical, "unit": json.loads(row["unit_json"]),
            "semanticRole": row["semantic_role"], "eventTimeRequirement": row["event_time_requirement"],
            "availabilityRequirement": row["availability_requirement"],
            "historicalDecisionPolicy": row["historical_decision_policy"],
            "researchUsePolicy": json.loads(row["research_use_policy_json"]), "presence": presence,
            "eventTimeEvidence": json.loads(row["event_time_evidence_json"]),
            "availabilityEvidence": json.loads(row["availability_evidence_json"]),
        })
    canonical_records = []
    for row in record_rows:
        record = {
            "sourceRecordId": row["source_record_id"], "adapterVersion": row["adapter_version"],
            "eventTime": row["event_time"], "availableAt": row["available_at"],
            "availableAtAuthority": row["available_at_authority"], "ingestedAt": row["ingested_at"],
            "payloadHash": row["payload_hash"], "manifestVersion": row["manifest_version"],
            "manifestReference": row["manifest_reference"], "requestId": row["request_id"],
            "sourceProvenanceRef": row["source_provenance_ref"], "fields": fields_by_record[row["record_order"]],
        }
        if row["source_revision_id"] is not None:
            record["sourceRevision"] = {"revisionId": row["source_revision_id"]}
            if row["source_revision_observed_at"] is not None:
                record["sourceRevision"]["observedAt"] = row["source_revision_observed_at"]
        canonical_records.append(record)
    dataset = {
        "schemaVersion": "1.0.0", "dictionaryId": schema["dictionaryId"],
        "dictionaryVersion": schema["dictionaryVersion"], "bindingId": schema["bindingId"],
        "bindingVersion": schema["bindingVersion"], "providerId": schema["providerId"],
        "adapterId": schema["adapterId"], "sourceDatasetRef": schema["sourceDatasetRef"],
        "records": canonical_records, "productionAuthority": False,
    }
    interchange = {
        "storageInterchangeVersion": INTERCHANGE_VERSION, "productionAuthority": False,
        "rawRecords": raw_records, "canonicalDataset": dataset,
    }
    validate_interchange(interchange)
    if field_semantics(dataset) != schema["orderedFieldSemantics"]:
        fail("SCHEMA_FIELD_SEMANTICS")
    if _sha256_bytes(canonical_json_bytes(interchange)) != manifest["bundleId"]:
        fail("BUNDLE_CONTENT_IDENTITY")
    return interchange


def load_research_storage_bundle(storage_root: str | os.PathLike[str], bundle_id: str) -> dict[str, Any]:
    root = _validated_root(storage_root)
    return _load_validated(_bundle_path(root, bundle_id))


def commit_research_storage_bundle(storage_root: str | os.PathLike[str], interchange: dict[str, Any]) -> dict[str, Any]:
    root = _validated_root(storage_root)
    validate_interchange(interchange)
    bundle_id = _sha256_bytes(canonical_json_bytes(interchange))
    final = _bundle_path(root, bundle_id)
    if final.exists():
        restored = _load_validated(final)
        if canonical_json_bytes(restored) != canonical_json_bytes(interchange):
            fail("BUNDLE_IDENTITY_COLLISION")
        return {"bundleId": bundle_id, "bundlePath": str(final), "idempotent": True, "productionAuthority": False}
    stage = root / f".stage-{uuid.uuid4().hex}"
    _contained(root, stage)
    stage.mkdir(mode=0o700)
    try:
        _write_parquet(stage / "raw_records.parquet", _raw_rows(interchange), _RAW_SCHEMA)
        _write_parquet(stage / "canonical_records.parquet", _canonical_record_rows(interchange), _RECORD_SCHEMA)
        _write_parquet(stage / "canonical_fields.parquet", _canonical_field_rows(interchange), _FIELD_SCHEMA)
        _write_bytes(stage / "canonical_schema.json", canonical_json_bytes(_schema_artifact(interchange)))
        manifest = _manifest(interchange, bundle_id, stage)
        _write_bytes(stage / MANIFEST_NAME, canonical_json_bytes(manifest))
        _validate_directory(stage, require_committed=False, expected_bundle_id=bundle_id)
        receipt = {"bundleId": bundle_id, "manifestSha256": _sha256_file(stage / MANIFEST_NAME), "storageSchemaVersion": STORAGE_SCHEMA_VERSION}
        _write_bytes(stage / COMMIT_MARKER_NAME, canonical_json_bytes(receipt))
        _validate_directory(stage, expected_bundle_id=bundle_id)
        try:
            os.replace(stage, final)
        except OSError as exc:
            raise ResearchStorageError("PHASE_9D_RESEARCH_STORAGE_INVALID:ATOMIC_PUBLISH_FAILED") from exc
        for artifact in final.iterdir():
            artifact.chmod(stat.S_IREAD | stat.S_IRGRP | stat.S_IROTH)
        _load_validated(final)
        return {"bundleId": bundle_id, "bundlePath": str(final), "idempotent": False, "productionAuthority": False}
    except Exception:
        if stage.exists():
            shutil.rmtree(stage, ignore_errors=True)
        raise


_PROJECTION_COLUMNS = [
    "record_order", "field_order", "field_id", "presence_state",
    "value_boolean", "value_int64", "value_float64", "value_string",
]


def read_canonical_fields_polars(storage_root: str | os.PathLike[str], bundle_id: str) -> list[dict[str, Any]]:
    root = _validated_root(storage_root)
    bundle = _bundle_path(root, bundle_id)
    _validate_directory(bundle)
    return pl.scan_parquet(bundle / "canonical_fields.parquet").select(_PROJECTION_COLUMNS).sort(["record_order", "field_order"]).collect().to_dicts()


def read_canonical_fields_duckdb(storage_root: str | os.PathLike[str], bundle_id: str) -> list[dict[str, Any]]:
    root = _validated_root(storage_root)
    bundle = _bundle_path(root, bundle_id)
    _validate_directory(bundle)
    parquet = bundle / "canonical_fields.parquet"
    connection = duckdb.connect(":memory:", config={"autoinstall_known_extensions": "false", "autoload_known_extensions": "false"})
    try:
        relation = connection.execute(
            "SELECT record_order, field_order, field_id, presence_state, value_boolean, value_int64, value_float64, value_string "
            "FROM read_parquet(?) ORDER BY record_order, field_order",
            [str(parquet)],
        )
        columns = [item[0] for item in relation.description]
        return [dict(zip(columns, row, strict=True)) for row in relation.fetchall()]
    finally:
        connection.close()
