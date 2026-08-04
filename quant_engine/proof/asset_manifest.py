"""Build a deterministic Pine -> Python -> registry readiness manifest.

The manifest contains source identities and classification evidence, never
strategy source text or host-specific paths.
"""

from __future__ import annotations

import ast
import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any


PROOF_LABELS = [
    "INDICATOR ASSET READINESS PROOF",
    "NOT A REAL STRATEGY BACKTEST",
    "NOT APPROVED FOR PAPER, TESTNET OR LIVE",
]


ASSET_CONTRACTS: tuple[dict[str, Any], ...] = (
    {"index": 1, "registry": "ChandelierExit", "python": "quant_engine/daemon.py", "symbol": "calc_chandelier_exit", "relation": "intended-translation", "classification": "needs-lifecycle", "reason": "Pine exposes direction-change Buy/Sell alerts but no order lifecycle."},
    {"index": 2, "registry": "CompositeMomentum", "python": "quant_engine/indicators/composite_momentum.py", "symbol": "calculate", "relation": "conceptual-derivative-not-translation", "classification": "pure-indicator", "reason": "Python header says it borrows the toolkit's aggregation idea; it is not a semantic translation."},
    {"index": 3, "registry": "DeltaFlow", "python": "quant_engine/indicators/deltaflow.py", "symbol": "calculate", "relation": "intended-translation", "classification": "pure-indicator", "reason": "Volume-profile visualization has no Pine entry, exit, or position lifecycle."},
    {"index": 4, "registry": "ElliottWave", "python": "quant_engine/indicators/elliott_wave.py", "symbol": "calculate", "relation": "intended-translation", "classification": "pure-indicator", "reason": "Wave annotation logic is not an executable order contract."},
    {"index": 5, "registry": "FibonacciEntryBands", "python": "quant_engine/indicators/fibonacci.py", "symbol": "calculate", "relation": "intended-translation", "classification": "needs-lifecycle", "reason": "Pine exposes entry/TP alerts but does not define a complete position lifecycle."},
    {"index": 6, "registry": "HullSuite", "python": "quant_engine/daemon.py", "symbol": "calc_hull_suite", "relation": "intended-translation", "classification": "needs-lifecycle", "reason": "Pine exposes Hull cross alerts but no executable position lifecycle."},
    {"index": 7, "registry": "MeanReversion", "python": "quant_engine/indicators/mean_reversion.py", "symbol": "calculate", "relation": "intended-translation", "classification": "pure-indicator", "reason": "Probability zones are context, not Pine order rules."},
    {"index": 8, "registry": "STC", "python": "quant_engine/indicators/stc.py", "symbol": "calculate", "relation": "intended-translation", "classification": "pure-indicator", "reason": "Oscillator values do not define entries, exits, or position state."},
    {"index": 9, "registry": "StochasticOverlay", "python": "quant_engine/indicators/stochastic.py", "symbol": "calculate", "relation": "intended-translation", "classification": "pure-indicator", "reason": "Overlay/channel state has no Pine order lifecycle."},
    {"index": 10, "registry": "SRRange", "python": "quant_engine/indicators/sr_range.py", "symbol": "calculate", "relation": "intended-translation", "classification": "pure-indicator", "reason": "Support/resistance regions are components, not standalone Pine orders."},
    {"index": 11, "registry": "SmartOrderBlock", "python": "quant_engine/indicators/smart_order_block.py", "symbol": "calculate", "relation": "conceptual-derivative-not-translation", "classification": "direct-strategy", "reason": "Pine has complete strategy calls, but the registered Python order-block component is not its translation."},
    {"index": 12, "registry": "TrendImpulse", "python": "quant_engine/indicators/trend_impulse.py", "symbol": "calculate", "relation": "intended-translation", "classification": "pure-indicator", "reason": "Trend and retest markers do not define a complete Pine order lifecycle."},
    {"index": 13, "registry": "UTBotAlerts", "python": "quant_engine/daemon.py", "symbol": "calc_ut_bot_alerts", "relation": "intended-translation", "classification": "needs-lifecycle", "reason": "Pine exposes Long/Short alerts but not exit/reversal accounting semantics."},
    {"index": 14, "registry": "VolumeProfile", "python": "quant_engine/indicators/volume_profile.py", "symbol": "calculate", "relation": "intended-translation", "classification": "pure-indicator", "reason": "Volume distribution and value area are indicator components only."},
)

REGISTRY_BINDINGS = {
    "ChandelierExit": "calc_chandelier_exit",
    "CompositeMomentum": "calc_composite_momentum",
    "DeltaFlow": "calc_deltaflow",
    "ElliottWave": "calc_elliott_wave",
    "FibonacciEntryBands": "calc_fibonacci",
    "HullSuite": "calc_hull_suite",
    "MeanReversion": "calc_mean_reversion",
    "STC": "calc_stc",
    "StochasticOverlay": "calc_stochastic_overlay",
    "SRRange": "calc_sr_range",
    "SmartOrderBlock": "calc_smart_order_block",
    "TrendImpulse": "calc_trend_impulse",
    "UTBotAlerts": "calc_ut_bot_alerts",
    "VolumeProfile": "calc_volume_profile",
}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _git_show_text(repo: Path, commit: str, path: str) -> str:
    """Read a file from a specific git commit as UTF-8 text.

    Fail-closed: any git error raises. Only called for validated 40-hex
    commits — there is no worktree fallback.
    """
    result = subprocess.run(
        ["git", "-C", str(repo), "show", f"{commit}:{path}"],
        capture_output=True, text=True, encoding="utf-8")
    if result.returncode != 0:
        stderr = result.stderr
        if "bad revision" in stderr or "unknown revision" in stderr or "does not have" in stderr or "exists on disk, but not in" in stderr:
            raise ValueError("ASSET_SOURCE_COMMIT_UNRESOLVABLE")
        if "does not exist in" in stderr:
            raise ValueError("ASSET_SOURCE_PATH_MISSING_AT_COMMIT")
        raise ValueError(f"ASSET_GIT_SHOW_ERROR: {stderr.strip()}")
    return result.stdout.replace("\r\n", "\n")


def _text_file_sha256(path: Path) -> str:
    """Hash canonical UTF-8/LF text, independent of checkout line endings."""
    return _sha256(path.read_text(encoding="utf-8").encode("utf-8"))


def _repo_file(repo: Path, relative: str) -> Path:
    path = (repo / relative).resolve()
    if repo.resolve() not in path.parents:
        raise ValueError("asset path escapes repository")
    return path


def _extract_pine_assets(source: str) -> list[dict[str, Any]]:
    lines = source.splitlines()
    assets: list[dict[str, Any]] = []
    for index in range(1, 15):
        prefix = f"{index}. "
        matches = [i for i, line in enumerate(lines) if line.startswith(prefix)]
        if len(matches) != 1 or matches[0] + 1 >= len(lines):
            raise ValueError(f"expected exactly one Pine asset heading {index}")
        title_index = matches[0]
        title = lines[title_index][len(prefix):]
        pine = lines[title_index + 1]
        kind = "strategy" if re.search(r"(?<![A-Za-z])strategy\s*\(", pine) else "indicator"
        strategy_calls = sorted(set(re.findall(r"strategy\.(entry|exit|close|order)\s*\(", pine)))
        assets.append({
            "index": index,
            "title": title,
            "kind": kind,
            "sha256": _sha256(pine.encode("utf-8")),
            "strategyCalls": strategy_calls,
        })
    return assets


def _symbol_sha256(source_text: str, symbol: str, path_hint: str) -> str:
    """Hash a named symbol's source segment from full source text.

    Uses ast.get_source_segment for exact extraction — identical semantics
    to the original Path-based version, but operates on in-memory text with
    no file I/O.
    """
    tree = ast.parse(source_text)
    nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name == symbol]
    if len(nodes) != 1:
        raise ValueError(f"expected exactly one symbol {symbol} in {path_hint}")
    segment = ast.get_source_segment(source_text, nodes[0])
    if not segment:
        raise ValueError(f"could not extract symbol {symbol}")
    return _sha256(segment.encode("utf-8"))


def _registry_entry_sha256(source_text: str, registry_name: str, binding: str, path_hint: str) -> str:
    """Hash the registry binding line from full source text.

    Matches the exact line in REGISTRY_BINDINGS style dict. No file I/O —
    operates on in-memory text.
    """
    pattern = re.compile(rf'^\s*"{re.escape(registry_name)}"\s*:\s*{re.escape(binding)}\s*,?\s*$')
    matches = [line.strip() for line in source_text.splitlines() if pattern.match(line)]
    if len(matches) != 1:
        raise ValueError(f"expected exactly one registry binding for {registry_name} in {path_hint}")
    return _sha256(matches[0].encode("utf-8"))


def build_asset_manifest(repo: Path, source_commit: str = "LOCAL") -> dict[str, Any]:
    repo = repo.resolve()
    pinned = bool(re.match(r"^[0-9a-f]{40}$", source_commit))

    def _read(repo_path: str) -> str:
        """Read source text: git-show for pinned commits, worktree for synthetic."""
        if pinned:
            return _git_show_text(repo, source_commit, repo_path)
        return _repo_file(repo, repo_path).read_text(encoding="utf-8")

    pine_source = _read("docs/all_indicators_pine_v2.txt")
    pine_assets = {item["index"]: item for item in _extract_pine_assets(pine_source)}

    daemon_text = _read("quant_engine/daemon.py")
    registry_text_source = _read("quant_engine/indicators/__init__.py")
    registry_text = daemon_text + "\n" + registry_text_source

    assets: list[dict[str, Any]] = []
    for contract in ASSET_CONTRACTS:
        pine = pine_assets[contract["index"]]
        if f'"{contract["registry"]}"' not in registry_text:
            raise ValueError(f"registry entry missing: {contract['registry']}")

        python_text = _read(contract["python"])
        registry_relative = "quant_engine/daemon.py" if contract["python"] == "quant_engine/daemon.py" else "quant_engine/indicators/__init__.py"
        registry_source = daemon_text if contract["python"] == "quant_engine/daemon.py" else registry_text_source
        registry_binding = REGISTRY_BINDINGS[contract["registry"]]

        blockers: list[str] = []
        if contract["classification"] == "needs-lifecycle":
            blockers.append("PINE_LIFECYCLE_INCOMPLETE")
        if contract["relation"] != "intended-translation":
            blockers.append("PYTHON_NOT_FAITHFUL_TRANSLATION")
        if pine["kind"] != "strategy":
            blockers.append("PINE_IS_INDICATOR")
        ready = not blockers and contract["classification"] == "direct-strategy"

        assets.append({
            **pine,
            "registryName": contract["registry"],
            "pythonPath": contract["python"],
            "pythonFileSha256": _sha256(python_text.encode("utf-8")),
            "pythonSymbol": contract["symbol"],
            "pythonSymbolSha256": _symbol_sha256(python_text, contract["symbol"], contract["python"]),
            "registryPath": registry_relative,
            "registryBinding": registry_binding,
            "registryEntrySha256": _registry_entry_sha256(registry_source, contract["registry"], registry_binding, registry_relative),
            "mappingRelation": contract["relation"],
            "classification": contract["classification"],
            "classificationReason": contract["reason"],
            "realWalkForwardReady": ready,
            "readinessBlockers": blockers,
        })

    counts = {name: sum(a["classification"] == name for a in assets) for name in ("direct-strategy", "needs-lifecycle", "pure-indicator")}
    payload: dict[str, Any] = {
        "schemaVersion": "stage-4a9.asset-readiness.v1",
        "labels": PROOF_LABELS,
        "sourceCommit": source_commit,
        "pineCollection": {
            "path": "docs/all_indicators_pine_v2.txt",
            "sha256": _sha256(pine_source.encode("utf-8")),
            "assetCount": len(assets),
        },
        "registry": {
            "daemonSha256": _sha256(daemon_text.encode("utf-8")),
            "indicatorRegistrySha256": _sha256(registry_text_source.encode("utf-8")),
        },
        "counts": {
            "pineAssetsVerified": len(assets),
            "directStrategies": counts["direct-strategy"],
            "needsLifecycle": counts["needs-lifecycle"],
            "pureIndicators": counts["pure-indicator"],
            "realWalkForwardReady": sum(a["realWalkForwardReady"] for a in assets),
        },
        "assets": assets,
    }
    payload["proofId"] = _sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    return payload


def verify_asset_manifest(repo: Path, manifest: dict[str, Any], expected_source_commit: str | None = None) -> None:
    source_commit = manifest.get("sourceCommit")
    if expected_source_commit is not None and source_commit != expected_source_commit:
        raise ValueError("ASSET_MANIFEST_COMMIT_MISMATCH")
    expected = build_asset_manifest(repo, source_commit=source_commit)
    if expected != manifest:
        raise ValueError("ASSET_MANIFEST_RECOMPUTATION_MISMATCH")
    if manifest["counts"]["pineAssetsVerified"] != 14:
        raise ValueError("ASSET_COUNT_MISMATCH")
    if sum(manifest["counts"][key] for key in ("directStrategies", "needsLifecycle", "pureIndicators")) != 14:
        raise ValueError("CLASSIFICATION_COUNT_MISMATCH")
