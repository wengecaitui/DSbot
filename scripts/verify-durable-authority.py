#!/usr/bin/env python3
"""Verify byte-exact durable Stage 4B/Stage 5 authority subjects."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path, PurePosixPath
from typing import Any


REPO = Path(__file__).resolve().parents[1]
REQUIRED_BINDING_FIELDS = {
    "id",
    "canonicalPath",
    "byteLength",
    "rawSha256",
    "subjectName",
    "historicalProducerWorkflow",
    "historicalProducerRun",
    "historicalSourceCommit",
    "semanticIdentityFields",
}


class DurableAuthorityError(ValueError):
    """A durable authority binding or subject failed closed."""


def _load_bindings(path: Path) -> list[dict[str, Any]]:
    try:
        value = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DurableAuthorityError("DURABLE_BINDINGS_INVALID") from error
    if not isinstance(value, dict) or not isinstance(value.get("subjects"), list):
        raise DurableAuthorityError("DURABLE_BINDINGS_INVALID")

    subjects: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_paths: set[str] = set()
    for item in value["subjects"]:
        if not isinstance(item, dict) or not REQUIRED_BINDING_FIELDS.issubset(item):
            raise DurableAuthorityError("DURABLE_BINDING_SHAPE_INVALID")
        subject_id = item["id"]
        canonical_path = item["canonicalPath"]
        if not isinstance(subject_id, str) or not subject_id:
            raise DurableAuthorityError("DURABLE_AUTHORITY_ID_INVALID")
        if subject_id in seen_ids:
            raise DurableAuthorityError(f"DUPLICATE_AUTHORITY_ID:{subject_id}")
        if not isinstance(canonical_path, str) or not canonical_path:
            raise DurableAuthorityError(f"CANONICAL_PATH_INVALID:{subject_id}")
        pure_path = PurePosixPath(canonical_path)
        if pure_path.is_absolute() or ".." in pure_path.parts or pure_path.as_posix() != canonical_path:
            raise DurableAuthorityError(f"CANONICAL_PATH_INVALID:{subject_id}")
        if canonical_path in seen_paths:
            raise DurableAuthorityError(f"DUPLICATE_CANONICAL_PATH:{canonical_path}")
        byte_length = item["byteLength"]
        raw_sha256 = item["rawSha256"]
        semantic_fields = item["semanticIdentityFields"]
        if type(byte_length) is not int or byte_length < 0:
            raise DurableAuthorityError(f"BYTE_LENGTH_INVALID:{subject_id}")
        if (
            not isinstance(raw_sha256, str)
            or len(raw_sha256) != 64
            or any(character not in "0123456789abcdef" for character in raw_sha256)
        ):
            raise DurableAuthorityError(f"RAW_SHA256_INVALID:{subject_id}")
        if not isinstance(semantic_fields, dict) or not semantic_fields:
            raise DurableAuthorityError(f"SEMANTIC_IDENTITY_FIELDS_INVALID:{subject_id}")
        seen_ids.add(subject_id)
        seen_paths.add(canonical_path)
        subjects.append(item)
    return subjects


def _semantic_value(value: Any, dotted_path: str) -> Any:
    current = value
    for part in dotted_path.split("."):
        if not isinstance(current, dict) or part not in current:
            raise DurableAuthorityError(f"SEMANTIC_FIELD_MISSING:{dotted_path}")
        current = current[part]
    return current


def verify_subject(binding: dict[str, Any], repo_root: Path) -> None:
    subject_id = binding["id"]
    canonical_path = binding["canonicalPath"]
    root = repo_root.resolve()
    path = (root / PurePosixPath(canonical_path)).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise DurableAuthorityError(f"CANONICAL_SUBJECT_MISSING:{subject_id}")

    raw = path.read_bytes()
    if len(raw) != binding["byteLength"]:
        raise DurableAuthorityError(f"BYTE_LENGTH_MISMATCH:{subject_id}")
    if hashlib.sha256(raw).hexdigest() != binding["rawSha256"]:
        raise DurableAuthorityError(f"RAW_SHA256_MISMATCH:{subject_id}")

    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DurableAuthorityError(f"SUBJECT_JSON_INVALID:{subject_id}") from error
    if not isinstance(value, dict):
        raise DurableAuthorityError(f"SUBJECT_JSON_NOT_OBJECT:{subject_id}")
    for dotted_path, expected in binding["semanticIdentityFields"].items():
        if not isinstance(dotted_path, str) or not dotted_path:
            raise DurableAuthorityError(f"SEMANTIC_FIELD_PATH_INVALID:{subject_id}")
        actual = _semantic_value(value, dotted_path)
        if type(actual) is not type(expected) or actual != expected:
            raise DurableAuthorityError(
                f"SEMANTIC_IDENTITY_MISMATCH:{subject_id}:{dotted_path}"
            )


def verify_subjects(bindings_path: Path, repo_root: Path, selected_ids: list[str]) -> list[str]:
    bindings = _load_bindings(bindings_path)
    by_id = {binding["id"]: binding for binding in bindings}
    subject_ids = selected_ids or [binding["id"] for binding in bindings]
    if len(subject_ids) != len(set(subject_ids)):
        raise DurableAuthorityError("DUPLICATE_SUBJECT_SELECTION")
    for subject_id in subject_ids:
        binding = by_id.get(subject_id)
        if binding is None:
            raise DurableAuthorityError(f"UNKNOWN_AUTHORITY_SUBJECT:{subject_id}")
        verify_subject(binding, repo_root)
    return subject_ids


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bindings", type=Path, required=True)
    parser.add_argument("--subject", action="append", default=[])
    parser.add_argument("--repo-root", type=Path, default=REPO)
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    bindings_path = args.bindings
    if not bindings_path.is_absolute():
        bindings_path = repo_root / bindings_path
    try:
        verified = verify_subjects(bindings_path.resolve(), repo_root, args.subject)
    except DurableAuthorityError as error:
        print(f"DURABLE_AUTHORITY_VERIFY=FAIL:{error}", file=sys.stderr)
        return 1
    print("DURABLE_AUTHORITY_VERIFY=PASS")
    print(f"VERIFIED_SUBJECTS={len(verified)}")
    for subject_id in verified:
        print(f"SUBJECT={subject_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
