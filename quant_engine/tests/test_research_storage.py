from __future__ import annotations

import copy
import hashlib
import inspect
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace

from quant_engine.research_storage import (
    commit_research_storage_bundle,
    load_research_storage_bundle,
    read_canonical_fields_duckdb,
    read_canonical_fields_polars,
    validate_research_storage_bundle,
)
from quant_engine.research_storage.schema import ResearchStorageError, canonical_json_bytes
import quant_engine.research_storage.parquet_store as store_module


POLICY = {
    "FACTOR_INPUT": "ALLOW", "LABEL": "DENY", "RESEARCH_VALUATION": "ALLOW",
    "UNIVERSE_FILTER": "DENY", "RESEARCH_EXECUTION_MODEL_INPUT": "DENY",
    "JOIN_KEY": "ALLOW", "DISPLAY": "ALLOW", "QUALITY_CONTROL": "ALLOW",
}


def evidence(state="KNOWN", value="2026-01-02T00:00:00.000Z"):
    if state == "KNOWN":
        return {"state": state, "value": value, "source": "RECORD_ENVELOPE"}
    if state == "DOCUMENTED_RULE_UNMATERIALIZED":
        return {"state": state, "rule": "Published under the provider's documented release rule."}
    return {"state": state}


def field(field_id, logical_type, presence, *, unit="UNITLESS", event=None, availability=None):
    return {
        "fieldId": field_id, "logicalType": logical_type, "unit": unit, "semanticRole": "MEASURE",
        "eventTimeRequirement": "RECORD_EVENT_TIME_SUFFICIENT",
        "availabilityRequirement": "RECORD_AVAILABLE_AT_SUFFICIENT",
        "historicalDecisionPolicy": "REQUIRES_PROVABLE_AVAILABILITY",
        "researchUsePolicy": dict(POLICY), "presence": presence,
        "eventTimeEvidence": event or evidence("KNOWN", "2026-01-01T00:00:00.000Z"),
        "availabilityEvidence": availability or evidence(),
    }


def encoded_payload(seed: int):
    return {
        "tag": "OBJECT",
        "entries": [
            ["bigint", {"tag": "BIGINT", "value": str(9007199254740993 + seed)}],
            ["empty", {"tag": "STRING", "value": ""}],
            ["false", {"tag": "BOOLEAN", "value": False}],
            ["nan", {"tag": "NAN"}],
            ["negativeInfinity", {"tag": "NEGATIVE_INFINITY"}],
            ["negativeZero", {"tag": "NEGATIVE_ZERO"}],
            ["nested", {"tag": "ARRAY", "items": [{"tag": "NUMBER", "value": seed}, {"tag": "OBJECT", "entries": [["0", {"tag": "STRING", "value": "object-key"}]]}]}],
            ["null", {"tag": "NULL"}],
            ["positiveInfinity", {"tag": "POSITIVE_INFINITY"}],
            ["undefined", {"tag": "UNDEFINED"}],
        ],
    }


def fixture():
    raw_records = []
    canonical_records = []
    for order, source_id in enumerate(("z-record", "a-record")):
        revision = {"revisionId": f"revision-{order + 1}", "observedAt": f"2026-09-0{order + 1}T00:00:00.000Z"}
        raw_records.append({
            "providerId": "example-provider", "adapterId": "example-adapter", "adapterVersion": "1.0.0",
            "sourceDatasetRef": "source:pit", "sourceRecordId": source_id,
            "eventTime": f"2026-01-0{order + 1}T00:00:00.000Z",
            "availableAt": None if order else "2026-01-02T00:00:00.000Z",
            "availableAtAuthority": "UNKNOWN" if order else "PROVIDER_FIELD",
            "ingestedAt": f"2026-09-0{order + 1}T00:00:00.000Z", "payload": encoded_payload(order),
            "payloadHash": chr(97 + order) * 64, "manifestVersion": "1.0.0",
            "manifestReference": "manifest:example", "requestId": f"request-{order + 1}",
            "sourceProvenanceRef": "provenance:example", "sourceRevision": revision,
        })
        known = evidence() if order == 0 else evidence("UNKNOWN")
        fields = [
            field("currency", "STRING", {"state": "VALUE", "value": "USD"}, availability=known),
            field(
                "price", "FLOAT64", {"state": "VALUE", "value": 10.5 + order},
                unit={"kind": "CURRENCY", "currencyFieldId": "currency"}, availability=known,
            ),
            field("missing", "STRING", {"state": "MISSING"}, availability=evidence("UNKNOWN")),
            field("nullable", "STRING", {"state": "NULL"}, availability=evidence("DOCUMENTED_RULE_UNMATERIALIZED")),
            field("zero", "INT64", {"state": "VALUE", "value": 0}, availability=known),
            field("false", "BOOLEAN", {"state": "VALUE", "value": False}, availability=known),
            field("empty", "STRING", {"state": "VALUE", "value": ""}, availability=known),
            field("decimal", {"kind": "DECIMAL", "precision": 8, "scale": 2}, {"state": "VALUE", "value": "1234.50"}, availability=known),
        ]
        canonical_records.append({
            "sourceRecordId": source_id, "adapterVersion": "1.0.0",
            "eventTime": raw_records[-1]["eventTime"], "availableAt": raw_records[-1]["availableAt"],
            "availableAtAuthority": raw_records[-1]["availableAtAuthority"], "ingestedAt": raw_records[-1]["ingestedAt"],
            "payloadHash": raw_records[-1]["payloadHash"], "manifestVersion": "1.0.0",
            "manifestReference": "manifest:example", "requestId": raw_records[-1]["requestId"],
            "sourceProvenanceRef": "provenance:example", "sourceRevision": revision, "fields": fields,
        })
    return {
        "storageInterchangeVersion": "DSBOT_RESEARCH_STORAGE_INTERCHANGE_V1", "productionAuthority": False,
        "rawRecords": raw_records,
        "canonicalDataset": {
            "schemaVersion": "1.0.0", "dictionaryId": "research.pit", "dictionaryVersion": "1.0.0",
            "bindingId": "provider.pit", "bindingVersion": "1.0.0", "providerId": "example-provider",
            "adapterId": "example-adapter", "sourceDatasetRef": "source:pit",
            "records": canonical_records, "productionAuthority": False,
        },
    }


class ResearchStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.value = fixture()

    def tearDown(self):
        for path in self.root.rglob("*"):
            try:
                path.chmod(stat.S_IWRITE | stat.S_IREAD)
            except OSError:
                pass
        self.temp.cleanup()

    def commit(self):
        return commit_research_storage_bundle(self.root, copy.deepcopy(self.value))

    def make_writable(self, path: Path):
        path.chmod(stat.S_IWRITE | stat.S_IREAD)

    def resign(self, bundle: Path, artifact_name: str):
        manifest_path = bundle / "bundle.manifest.json"
        receipt_path = bundle / "COMMITTED"
        self.make_writable(manifest_path)
        self.make_writable(receipt_path)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        artifact = bundle / artifact_name
        entry = next(item for item in manifest["files"] if item["path"] == artifact_name)
        entry["byteLength"] = artifact.stat().st_size
        entry["sha256"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
        manifest_path.write_bytes(canonical_json_bytes(manifest))
        receipt = {
            "bundleId": manifest["bundleId"],
            "manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            "storageSchemaVersion": manifest["storageSchemaVersion"],
        }
        receipt_path.write_bytes(canonical_json_bytes(receipt))

    def assert_invalid(self, callback, pattern="PHASE_9D_RESEARCH_STORAGE_INVALID"):
        with self.assertRaisesRegex(ResearchStorageError, pattern):
            callback()

    @staticmethod
    def set_price(value, price: int | float):
        for record in value["canonicalDataset"]["records"]:
            record["fields"][1]["presence"]["value"] = price

    def assert_no_publish_or_stage(self):
        self.assertEqual(list(self.root.iterdir()), [])

    def test_full_interchange_round_trip_is_exact(self):
        result = self.commit()
        self.assertEqual(load_research_storage_bundle(self.root, result["bundleId"]), self.value)
        self.assertFalse(result["productionAuthority"])

    def test_presence_zero_false_empty_decimal_and_safe_int_survive(self):
        result = self.commit()
        fields = load_research_storage_bundle(self.root, result["bundleId"])["canonicalDataset"]["records"][0]["fields"]
        self.assertEqual([item["presence"]["state"] for item in fields[2:5]], ["MISSING", "NULL", "VALUE"])
        self.assertEqual(fields[4]["presence"]["value"], 0)
        self.assertIs(fields[5]["presence"]["value"], False)
        self.assertEqual(fields[6]["presence"]["value"], "")
        self.assertEqual(fields[7]["presence"]["value"], "1234.50")

    def test_raw_payload_tagged_edge_cases_survive(self):
        result = self.commit()
        payload = load_research_storage_bundle(self.root, result["bundleId"])["rawRecords"][0]["payload"]
        self.assertEqual(payload, encoded_payload(0))

    def test_time_evidence_and_three_clocks_survive(self):
        result = self.commit()
        loaded = load_research_storage_bundle(self.root, result["bundleId"])
        record = loaded["canonicalDataset"]["records"][0]
        self.assertEqual((record["eventTime"], record["availableAt"], record["ingestedAt"]), (
            "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-09-01T00:00:00.000Z"))
        self.assertEqual(record["fields"][2]["availabilityEvidence"]["state"], "UNKNOWN")
        self.assertEqual(record["fields"][3]["availabilityEvidence"]["state"], "DOCUMENTED_RULE_UNMATERIALIZED")

    def test_record_field_order_and_revisions_survive_without_winner(self):
        result = self.commit()
        records = load_research_storage_bundle(self.root, result["bundleId"])["canonicalDataset"]["records"]
        self.assertEqual([item["sourceRecordId"] for item in records], ["z-record", "a-record"])
        self.assertEqual([item["sourceRevision"]["revisionId"] for item in records], ["revision-1", "revision-2"])
        self.assertEqual([item["fieldId"] for item in records[0]["fields"]], [
            "currency", "price", "missing", "nullable", "zero", "false", "empty", "decimal"])

    def test_bundle_has_one_closed_authority_shape(self):
        result = self.commit()
        bundle = Path(result["bundlePath"])
        self.assertEqual({item.name for item in bundle.iterdir()}, {
            "raw_records.parquet", "canonical_records.parquet", "canonical_fields.parquet",
            "canonical_schema.json", "bundle.manifest.json", "COMMITTED"})
        self.assertFalse(any(item.suffix in {".db", ".duckdb"} for item in bundle.iterdir()))

    def test_manifest_integrity_and_receipt_validate(self):
        result = self.commit()
        manifest = validate_research_storage_bundle(self.root, result["bundleId"])
        self.assertEqual(manifest["bundleId"], result["bundleId"])
        self.assertFalse(manifest["productionAuthority"])
        self.assertEqual((manifest["rawRecordCount"], manifest["canonicalRecordCount"], manifest["canonicalFieldCount"]), (2, 2, 16))

    def test_identical_commit_is_idempotent_after_full_validation(self):
        first = self.commit()
        second = self.commit()
        self.assertEqual(first["bundleId"], second["bundleId"])
        self.assertTrue(second["idempotent"])

    def test_float64_whole_numbers_have_one_semantic_identity_and_retry_is_idempotent(self):
        for integer_value in (10, 0, -2):
            with self.subTest(value=integer_value):
                first_value = fixture()
                second_value = fixture()
                self.set_price(first_value, integer_value)
                self.set_price(second_value, float(integer_value))
                first = commit_research_storage_bundle(self.root, first_value)
                for record in first_value["canonicalDataset"]["records"]:
                    self.assertIs(type(record["fields"][1]["presence"]["value"]), int)
                second = commit_research_storage_bundle(self.root, second_value)
                restored = load_research_storage_bundle(self.root, first["bundleId"])
                self.assertEqual(first["bundleId"], second["bundleId"])
                self.assertTrue(second["idempotent"])
                for record in restored["canonicalDataset"]["records"]:
                    self.assertIs(type(record["fields"][1]["presence"]["value"]), float)
                    self.assertEqual(record["fields"][1]["presence"]["value"], float(integer_value))

    def test_float64_fraction_int64_and_decimal_semantics_do_not_drift(self):
        self.set_price(self.value, 10.5)
        for record in self.value["canonicalDataset"]["records"]:
            record["fields"][4]["presence"]["value"] = 10
            record["fields"][7]["presence"]["value"] = "10.00"
        result = self.commit()
        records = load_research_storage_bundle(self.root, result["bundleId"])["canonicalDataset"]["records"]
        for record in records:
            self.assertIs(type(record["fields"][1]["presence"]["value"]), float)
            self.assertEqual(record["fields"][1]["presence"]["value"], 10.5)
            self.assertIs(type(record["fields"][4]["presence"]["value"]), int)
            self.assertEqual(record["fields"][4]["presence"]["value"], 10)
            self.assertIs(type(record["fields"][7]["presence"]["value"]), str)
            self.assertEqual(record["fields"][7]["presence"]["value"], "10.00")

    def test_full_semantic_validation_failure_cannot_publish_final(self):
        error = ResearchStorageError("PHASE_9D_RESEARCH_STORAGE_INVALID:FORCED_STAGE_SEMANTIC_FAILURE")
        with mock.patch.object(store_module.os, "replace", wraps=os.replace) as replace_mock:
            with mock.patch.object(store_module, "_load_validated", side_effect=error):
                with self.assertRaisesRegex(ResearchStorageError, "FORCED_STAGE_SEMANTIC_FAILURE"):
                    self.commit()
        replace_mock.assert_not_called()
        self.assert_no_publish_or_stage()

    def test_permission_failure_happens_before_publish_and_cleans_stage(self):
        real_chmod = Path.chmod
        calls = 0

        def fail_after_partial_hardening(path, mode, *, follow_symlinks=True):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise PermissionError("forced permission failure")
            return real_chmod(path, mode, follow_symlinks=follow_symlinks)

        with mock.patch.object(Path, "chmod", autospec=True, side_effect=fail_after_partial_hardening):
            with self.assertRaisesRegex(PermissionError, "forced permission failure"):
                self.commit()
        self.assertGreaterEqual(calls, 2)
        self.assert_no_publish_or_stage()

    def test_atomic_rename_failure_has_no_orphan_stage_or_copy_fallback(self):
        with mock.patch.object(store_module.os, "replace", side_effect=OSError("forced rename failure")):
            self.assert_invalid(self.commit, "ATOMIC_PUBLISH_FAILED")
        self.assert_no_publish_or_stage()

    def test_no_fallible_semantic_or_permission_operation_after_publish(self):
        source = inspect.getsource(store_module.commit_research_storage_bundle)
        post_publish = source.split("os.replace(stage, final)", maxsplit=1)[1]
        self.assertNotIn("_load_validated", post_publish)
        self.assertNotIn("chmod", post_publish)

    def test_collision_with_corrupt_existing_content_fails_closed(self):
        result = self.commit()
        artifact = Path(result["bundlePath"]) / "raw_records.parquet"
        self.make_writable(artifact)
        artifact.write_bytes(b"different")
        self.assert_invalid(self.commit)

    def test_missing_commit_marker_rejected(self):
        result = self.commit()
        marker = Path(result["bundlePath"]) / "COMMITTED"
        self.make_writable(marker)
        marker.unlink()
        self.assert_invalid(lambda: validate_research_storage_bundle(self.root, result["bundleId"]))

    def test_missing_declared_file_rejected(self):
        result = self.commit()
        artifact = Path(result["bundlePath"]) / "canonical_records.parquet"
        self.make_writable(artifact)
        artifact.unlink()
        self.assert_invalid(lambda: validate_research_storage_bundle(self.root, result["bundleId"]))

    def test_extra_undeclared_file_rejected(self):
        result = self.commit()
        (Path(result["bundlePath"]) / "extra.txt").write_text("extra", encoding="utf-8")
        self.assert_invalid(lambda: validate_research_storage_bundle(self.root, result["bundleId"]))

    def test_truncated_parquet_and_hash_mismatch_rejected(self):
        result = self.commit()
        artifact = Path(result["bundlePath"]) / "canonical_fields.parquet"
        self.make_writable(artifact)
        artifact.write_bytes(artifact.read_bytes()[:32])
        self.assert_invalid(lambda: load_research_storage_bundle(self.root, result["bundleId"]))

    def test_byte_length_mismatch_rejected(self):
        result = self.commit()
        artifact = Path(result["bundlePath"]) / "raw_records.parquet"
        self.make_writable(artifact)
        artifact.write_bytes(artifact.read_bytes() + b"x")
        self.assert_invalid(lambda: validate_research_storage_bundle(self.root, result["bundleId"]), "ARTIFACT_BYTE_LENGTH")

    def test_unsupported_storage_schema_rejected_even_with_resigned_integrity(self):
        result = self.commit()
        bundle = Path(result["bundlePath"])
        schema_path = bundle / "canonical_schema.json"
        self.make_writable(schema_path)
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        schema["storageSchemaVersion"] = "UNSUPPORTED"
        schema_path.write_bytes(canonical_json_bytes(schema))
        self.resign(bundle, "canonical_schema.json")
        self.assert_invalid(lambda: load_research_storage_bundle(self.root, result["bundleId"]), "MALFORMED_SCHEMA")

    def test_partial_uncommitted_bundle_rejected(self):
        bundle_id = "f" * 64
        partial = self.root / bundle_id
        partial.mkdir()
        (partial / "raw_records.parquet").write_bytes(b"partial")
        self.assert_invalid(lambda: validate_research_storage_bundle(self.root, bundle_id))

    def test_relative_traversal_absolute_id_and_remote_roots_rejected(self):
        self.assert_invalid(lambda: validate_research_storage_bundle(self.root, "../escape"), "BUNDLE_ID")
        self.assert_invalid(lambda: validate_research_storage_bundle(self.root, str(self.root / ("a" * 64))), "BUNDLE_ID")
        for remote in ("https://host/data", "file://local/data", "s3://bucket/data", "\\\\server\\share"):
            self.assert_invalid(lambda remote=remote: commit_research_storage_bundle(remote, self.value), "ROOT_NOT_LOCAL")
        traversing_root = str(self.root / "child" / "..")
        self.assert_invalid(lambda: commit_research_storage_bundle(traversing_root, self.value), "ROOT_TRAVERSAL")

    def test_forged_static_eligibility_in_schema_is_rejected_even_if_resigned(self):
        result = self.commit()
        bundle = Path(result["bundlePath"])
        schema_path = bundle / "canonical_schema.json"
        self.make_writable(schema_path)
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        schema["pointInTimeSafe"] = True
        schema_path.write_bytes(canonical_json_bytes(schema))
        self.resign(bundle, "canonical_schema.json")
        self.assert_invalid(lambda: load_research_storage_bundle(self.root, result["bundleId"]), "MALFORMED_SCHEMA")

    def test_symlink_or_reparse_root_rejected_when_platform_allows(self):
        link = self.root.parent / f"phase9d-link-{os.getpid()}"
        try:
            link.symlink_to(self.root, target_is_directory=True)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"platform cannot create symlink/reparse test fixture: {exc}")
        try:
            self.assert_invalid(lambda: commit_research_storage_bundle(link, self.value), "SYMLINK_OR_REPARSE_POINT")
        finally:
            link.unlink(missing_ok=True)

    def test_windows_reparse_attribute_guard_is_explicit(self):
        simulated = SimpleNamespace(st_file_attributes=0x400)
        self.assertTrue(store_module._is_reparse(simulated))

    def test_duckdb_polars_fixed_projection_equivalence(self):
        result = self.commit()
        duck = read_canonical_fields_duckdb(self.root, result["bundleId"])
        polars = read_canonical_fields_polars(self.root, result["bundleId"])
        self.assertEqual(duck, polars)
        self.assertEqual(len(duck), 16)

    def test_no_arbitrary_sql_or_mutation_api(self):
        source = inspect.getsource(store_module)
        self.assertNotIn("def execute_sql", source)
        for forbidden in ("INSTALL ", "LOAD ", "ATTACH ", "COPY "):
            self.assertNotIn(forbidden, source)
        self.assertFalse(any(name.startswith(("delete", "vacuum", "compact", "overwrite")) for name in dir(store_module)))

    def test_no_static_eligibility_or_later_phase_authority(self):
        result = self.commit()
        bundle = Path(result["bundlePath"])
        text = "\n".join(item.read_text(encoding="utf-8", errors="ignore") for item in bundle.iterdir() if item.suffix == ".json" or item.name == "COMMITTED")
        for forbidden in ("pointInTimeSafe", "BACKTEST_ELIGIBLE", "datasetEligible", "historicallySafe", "paperReady", "testnetReady", "liveReady"):
            self.assertNotIn(forbidden, text)
        self.assertFalse(json.loads((bundle / "bundle.manifest.json").read_text(encoding="utf-8"))["productionAuthority"])


if __name__ == "__main__":
    unittest.main()
