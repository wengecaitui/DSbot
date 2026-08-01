"""Stage 5.4-C — Frozen strategy rule observation producer.

Converts canonical StrategySpec payloads plus causal component snapshots
into independent Stage5StrategyIntentObservation booleans per scored bar.
No indicator computation, position tracking, trade simulation, or replay.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

from quant_engine.proof.stage5_evaluation import canonical_sha256
from quant_engine.proof.stage5_intent_compiler import (
    Stage5StrategyIntentObservation,
    create_stage5_strategy_intent_observation,
)
from quant_engine.proof.stage5_lifecycle_plan import TIMEFRAME

RULE_SPEC_SCHEMA = "stage-5.rule-spec.v1"
SNAPSHOT_SCHEMA = "stage-5.component-snapshot.v1"
BATCH_SCHEMA = "stage-5.observation-batch.v1"
SUPPORTED_EXECUTION = "closed-bar-next-open"
_SHA = re.compile(r"^[a-f0-9]{64}$")
_SUPPORTED_OPS = {"eq","gte","lte"}


def _vsha(v, label):
    if type(v) is not str: raise ValueError(f"{label}_MALFORMED")
    if not _SHA.fullmatch(v): raise ValueError(f"{label}_MALFORMED")


def _vint(v, label):
    if isinstance(v, bool) or type(v) is not int: raise ValueError(f"{label}_NOT_INT")
    if v < 0: raise ValueError(f"{label}_NEGATIVE")


def _vbool(v, label):
    if type(v) is not bool: raise ValueError(f"{label}_NOT_BOOL")


def _vstr(v, label):
    if type(v) is not str: raise ValueError(f"{label}_NOT_STRING")
    if not v: raise ValueError(f"{label}_EMPTY")


def _canonicalize(value):
    """Exact-type recursive canonicalizer. No isinstance/Sequence/Mapping."""
    if value is None:
        return None
    t = type(value)
    if t is bool:
        return value
    if t is int:
        return value
    if t is float:
        if math.isnan(value) or math.isinf(value):
            raise ValueError("CANONICAL_NAN_INF")
        return value
    if t is str:
        return value
    if t is list:
        return tuple(_canonicalize(v) for v in value)
    if t is tuple:
        return tuple(_canonicalize(v) for v in value)
    if t is dict:
        for k in value:
            if type(k) is not str:
                raise ValueError("CANONICAL_NON_STR_KEY")
        return tuple(sorted((k, _canonicalize(v)) for k,v in value.items()))
    raise ValueError("CANONICAL_UNSUPPORTED_TYPE")


def _safe_compare(actual, operator, expected):
    if operator == "eq":
        return actual == expected
    if operator in ("gte","lte"):
        at = type(actual); et = type(expected)
        if at is bool or et is bool: raise ValueError("RULE_COMPARE_BOOL")
        if at is not int and at is not float: raise ValueError("RULE_COMPARE_NON_NUMERIC")
        if et is not int and et is not float: raise ValueError("RULE_COMPARE_NON_NUMERIC")
        a = float(actual); e = float(expected)
        if math.isnan(a) or math.isinf(a) or math.isnan(e) or math.isinf(e):
            raise ValueError("RULE_COMPARE_NAN_INF")
        return a >= e if operator == "gte" else a <= e
    raise ValueError(f"RULE_OPERATOR_INVALID:{operator}")


@dataclass(frozen=True)
class Stage5FrozenRuleSpec:
    schema_version: str
    strategy_id: str
    version: str
    spec_id: str
    parameter_id: str
    components: tuple[str, ...]
    entry_rules: tuple[tuple[str, str, tuple[tuple[str, str, str, object], ...]], ...]
    exit_rules: tuple[tuple[str, str, tuple[tuple[str, str, str, object], ...]], ...]
    warmup_bars: int
    frozen_id: str

    def __post_init__(self):
        if type(self.schema_version) is not str:
            raise ValueError("SPEC_SCHEMA_NOT_STR")
        if self.schema_version != RULE_SPEC_SCHEMA:
            raise ValueError("SPEC_SCHEMA_INVALID")
        _vstr(self.strategy_id, "SPEC_STRATEGY_ID")
        if not self.strategy_id.startswith("derived-"):
            raise ValueError("SPEC_STRATEGY_ID_INVALID")
        _vstr(self.version, "SPEC_VERSION")
        _vsha(self.spec_id, "SPEC_SPEC_ID")
        _vsha(self.parameter_id, "SPEC_PARAM_ID")
        if type(self.components) is not tuple or len(self.components) == 0:
            raise ValueError("SPEC_COMPONENTS_INVALID")
        if len(set(self.components)) != len(self.components):
            raise ValueError("SPEC_COMPONENTS_DUPLICATE")
        for c in self.components:
            if type(c) is not str or not c:
                raise ValueError("SPEC_COMPONENT_ITEM_INVALID")
        if type(self.entry_rules) is not tuple or len(self.entry_rules)==0:
            raise ValueError("SPEC_ENTRY_RULES_EMPTY")
        if type(self.exit_rules) is not tuple or len(self.exit_rules)==0:
            raise ValueError("SPEC_EXIT_RULES_EMPTY")
        self._validate_rules(self.entry_rules, is_entry=True)
        self._validate_rules(self.exit_rules, is_entry=False)
        _vint(self.warmup_bars, "SPEC_WARMUP")
        if self.warmup_bars < 2:
            raise ValueError("SPEC_WARMUP_INVALID")
        payload = self._frozen_payload()
        expected = canonical_sha256(payload)
        if self.frozen_id != expected:
            raise ValueError("SPEC_ID_MISMATCH")

    def _frozen_payload(self):
        return {
            "schemaVersion": self.schema_version,
            "strategyId": self.strategy_id, "version": self.version,
            "specId": self.spec_id, "parameterId": self.parameter_id,
            "components": list(self.components),
            "entryRules": [[s,m,[[c,f,o,v] for c,f,o,v in cls]] for s,m,cls in self.entry_rules],
            "exitRules": [[s,m,[[c,f,o,v] for c,f,o,v in cls]] for s,m,cls in self.exit_rules],
            "warmupBars": self.warmup_bars,
        }

    @staticmethod
    def _validate_rules(rules, is_entry):
        seen = set()
        for rule in rules:
            if type(rule) is not tuple or len(rule) != 3:
                raise ValueError("SPEC_RULE_SHAPE_INVALID")
            side_pos, mode, clauses = rule
            if type(side_pos) is not str:
                raise ValueError("SPEC_RULE_SIDE_NOT_STR")
            if type(mode) is not str:
                raise ValueError("SPEC_RULE_MODE_NOT_STR")
            if is_entry and side_pos not in ("long","short"):
                raise ValueError("SPEC_ENTRY_SIDE_INVALID")
            if not is_entry and side_pos not in ("long","short"):
                raise ValueError("SPEC_EXIT_POS_INVALID")
            if mode not in ("all","any"):
                raise ValueError("SPEC_RULE_MODE_INVALID")
            if type(clauses) is not tuple or len(clauses)==0:
                raise ValueError("SPEC_CLAUSES_EMPTY")
            rk = (side_pos, mode, clauses)
            if rk in seen:
                raise ValueError("SPEC_RULE_DUPLICATE")
            seen.add(rk)
            for c in clauses:
                if type(c) is not tuple or len(c) != 4:
                    raise ValueError("SPEC_CLAUSE_SHAPE_INVALID")
                comp, field, op, val = c
                if type(comp) is not str or not comp:
                    raise ValueError("SPEC_CLAUSE_COMP_INVALID")
                if type(field) is not str or not field:
                    raise ValueError("SPEC_CLAUSE_FIELD_INVALID")
                if type(op) is not str or op not in _SUPPORTED_OPS:
                    raise ValueError("SPEC_CLAUSE_OP_INVALID")

    def _matches(self, rule, outputs):
        _, mode, clauses = rule
        checks = []
        for comp, field, op, expected in clauses:
            if comp not in outputs:
                raise ValueError(f"PROD_COMP_MISSING:{comp}")
            comp_out = outputs[comp]
            if type(comp_out) is not dict:
                raise ValueError(f"PROD_COMP_NOT_DICT:{comp}")
            if field not in comp_out:
                raise ValueError(f"PROD_FIELD_MISSING:{comp}.{field}")
            actual = comp_out[field]
            try:
                checks.append(_safe_compare(actual, op, expected))
            except ValueError:
                raise
        return all(checks) if mode == "all" else any(checks)


def create_frozen_rule_spec(payload: dict, expected_spec_id: str, parameter_set: dict) -> Stage5FrozenRuleSpec:
    if type(payload) is not dict:
        raise ValueError("FACTORY_PAYLOAD_NOT_DICT")
    if type(expected_spec_id) is not str:
        raise ValueError("FACTORY_SPEC_ID_NOT_STR")
    if type(parameter_set) is not dict:
        raise ValueError("FACTORY_PARAM_NOT_DICT")
    if any(type(k) is not str for k in payload):
        raise ValueError("FACTORY_KEY_NOT_STR")
    if any(type(k) is not str for k in parameter_set):
        raise ValueError("FACTORY_PARAM_KEY_NOT_STR")

    # Required fields
    required = ["strategyId","version","components","entryRules","exitRules",
                "positionLifecycle","riskRules","timeframe","symbols","parameters",
                "warmupBars","executionTiming","costModel","sourceAssetDigests"]
    for key in required:
        if key not in payload:
            raise ValueError(f"FACTORY_MISSING_{key.upper()}")

    sid = payload["strategyId"]
    _vstr(sid, "FACTORY_STRATEGY_ID")
    if not sid.startswith("derived-"):
        raise ValueError("FACTORY_STRATEGY_ID_INVALID")
    ver = payload["version"]
    _vstr(ver, "FACTORY_VERSION")

    # Execution timing
    exec_timing = payload["executionTiming"]
    if type(exec_timing) is not str or exec_timing != SUPPORTED_EXECUTION:
        raise ValueError("FACTORY_EXEC_TIMING_INVALID")

    # Timeframe
    timeframe = payload["timeframe"]
    if type(timeframe) is not list or not timeframe:
        raise ValueError("FACTORY_TIMEFRAME_INVALID")
    if "5m" not in timeframe:
        raise ValueError("FACTORY_TIMEFRAME_NO_5M")

    # Symbols
    symbols = payload["symbols"]
    if type(symbols) is not list or not symbols:
        raise ValueError("FACTORY_SYMBOLS_INVALID")

    # Warmup
    warmup = payload["warmupBars"]
    if type(warmup) is not int or warmup < 2:
        raise ValueError("FACTORY_WARMUP_INVALID")

    # Components
    components_raw = payload["components"]
    if type(components_raw) is not list or not components_raw:
        raise ValueError("FACTORY_COMPONENTS_INVALID")
    components = []
    for ci in components_raw:
        if type(ci) is not dict or type(ci.get("assetId")) is not str or not ci["assetId"]:
            raise ValueError("FACTORY_COMPONENT_INVALID")
        if "parameterMap" not in ci or type(ci["parameterMap"]) is not dict:
            raise ValueError("FACTORY_COMPONENT_PARAM_MAP_INVALID")
        components.append(ci["assetId"])
    if len(set(components)) != len(components):
        raise ValueError("FACTORY_COMPONENTS_DUPLICATE")

    # Parameters
    params = payload["parameters"]
    if type(params) is not dict:
        raise ValueError("FACTORY_PARAMETERS_NOT_DICT")
    if params.get("selectionPolicy") != "explicit-enumeration-only":
        raise ValueError("FACTORY_SELECTION_POLICY_INVALID")
    candidate_sets = params.get("candidateSets")
    if type(candidate_sets) is not list or not candidate_sets:
        raise ValueError("FACTORY_CANDIDATE_SETS_INVALID")
    param_canon = _canonicalize(parameter_set)
    found = False
    for cs in candidate_sets:
        if type(cs) is not dict:
            raise ValueError("FACTORY_CANDIDATE_NOT_DICT")
        if _canonicalize(cs) == param_canon:
            found = True; break
    if not found:
        raise ValueError("FACTORY_PARAMETER_NOT_IN_CANDIDATE_SETS")

    # Position lifecycle
    plc = payload["positionLifecycle"]
    if type(plc) is not dict or not plc.get("flatEntry") or not plc.get("reversal"):
        raise ValueError("FACTORY_LIFECYCLE_INVALID")

    # Risk rules
    risk = payload["riskRules"]
    if type(risk) is not dict or not risk.get("stopLoss") or not risk.get("takeProfit"):
        raise ValueError("FACTORY_RISK_INVALID")

    # Cost model
    cost = payload["costModel"]
    if type(cost) is not dict:
        raise ValueError("FACTORY_COST_MODEL_INVALID")

    # Source asset digests
    digests = payload["sourceAssetDigests"]
    if type(digests) is not dict:
        raise ValueError("FACTORY_DIGESTS_NOT_DICT")
    for comp_name in components:
        if comp_name not in digests:
            raise ValueError(f"FACTORY_DIGEST_MISSING:{comp_name}")
        d = digests[comp_name]
        if type(d) is not dict:
            raise ValueError(f"FACTORY_DIGEST_NOT_DICT:{comp_name}")
        for v in d.values():
            if type(v) is not str or not _SHA.fullmatch(v):
                raise ValueError(f"FACTORY_DIGEST_BAD_SHA:{comp_name}")

    # Parse rules
    def parse_rules(rules_raw, is_entry):
        if type(rules_raw) is not list or len(rules_raw)==0:
            raise ValueError("FACTORY_RULES_EMPTY" if is_entry else "FACTORY_EXIT_RULES_EMPTY")
        rules = []
        seen = set()
        for r in rules_raw:
            if type(r) is not dict:
                raise ValueError("FACTORY_RULE_NOT_DICT")
            side = r.get("side" if is_entry else "position")
            if type(side) is not str:
                raise ValueError("FACTORY_RULE_SIDE_INVALID")
            if is_entry and side not in ("long","short"):
                raise ValueError("FACTORY_ENTRY_SIDE_INVALID")
            if not is_entry and side not in ("long","short"):
                raise ValueError("FACTORY_EXIT_POS_INVALID")
            has_all = "all" in r
            has_any = "any" in r
            if has_all and has_any:
                raise ValueError("FACTORY_RULE_BOTH_MODES")
            if not has_all and not has_any:
                raise ValueError("FACTORY_RULE_MODE_MISSING")
            mode = "all" if has_all else "any"
            clauses = r[mode]
            if type(clauses) is not list or len(clauses)==0:
                raise ValueError("FACTORY_CLAUSES_EMPTY")
            parsed = []
            for c in clauses:
                if type(c) is not dict:
                    raise ValueError("FACTORY_CLAUSE_NOT_DICT")
                comp = c.get("component"); field = c.get("field"); op = c.get("operator","eq"); val = c.get("value")
                if type(comp) is not str or not comp:
                    raise ValueError("FACTORY_CLAUSE_COMP_INVALID")
                if type(field) is not str or not field:
                    raise ValueError("FACTORY_CLAUSE_FIELD_INVALID")
                if type(op) is not str or op not in _SUPPORTED_OPS:
                    raise ValueError("FACTORY_CLAUSE_OP_INVALID")
                if comp not in components:
                    raise ValueError(f"FACTORY_CLAUSE_COMP_UNKNOWN:{comp}")
                try:
                    cval = _canonicalize(val)
                except ValueError:
                    raise
                parsed.append((comp, field, op, cval))
            rule = (side, mode, tuple(parsed))
            if rule in seen:
                raise ValueError("FACTORY_RULE_DUPLICATE")
            seen.add(rule)
            rules.append(rule)
        return tuple(rules)

    entry_rules = parse_rules(payload["entryRules"], True)
    exit_rules = parse_rules(payload["exitRules"], False)

    # Compute spec ID and verify
    spec_payload = dict(payload)
    computed_spec_id = canonical_sha256(spec_payload)
    if computed_spec_id != expected_spec_id:
        raise ValueError("FACTORY_SPEC_ID_MISMATCH")

    parameter_id = canonical_sha256(param_canon)

    frozen_payload = {
        "schemaVersion": RULE_SPEC_SCHEMA, "strategyId": sid, "version": ver,
        "specId": computed_spec_id, "parameterId": parameter_id,
        "components": list(tuple(components)),
        "entryRules": [[s,m,[[c,f,o,v] for c,f,o,v in cls]] for s,m,cls in entry_rules],
        "exitRules": [[s,m,[[c,f,o,v] for c,f,o,v in cls]] for s,m,cls in exit_rules],
        "warmupBars": warmup,
    }

    return Stage5FrozenRuleSpec(
        schema_version=RULE_SPEC_SCHEMA,
        strategy_id=sid, version=ver,
        spec_id=computed_spec_id, parameter_id=parameter_id,
        components=tuple(components),
        entry_rules=entry_rules, exit_rules=exit_rules,
        warmup_bars=warmup,
        frozen_id=canonical_sha256(frozen_payload),
    )


@dataclass(frozen=True)
class Stage5ComponentSnapshot:
    schema_version: str
    strategy_id: str
    spec_id: str
    parameter_id: str
    dataset_id: str
    symbol: str
    bar_open_time_ms: int
    has_outputs: bool
    components: tuple[tuple[str, tuple[tuple[str, object], ...]], ...]
    snapshot_id: str

    def __post_init__(self):
        if type(self.schema_version) is not str:
            raise ValueError("SNAP_SCHEMA_NOT_STR")
        if self.schema_version != SNAPSHOT_SCHEMA:
            raise ValueError("SNAP_SCHEMA_INVALID")
        _vstr(self.strategy_id, "SNAP_STRATEGY")
        _vsha(self.spec_id, "SNAP_SPEC")
        _vsha(self.parameter_id, "SNAP_PARAM")
        _vsha(self.dataset_id, "SNAP_DATASET")
        _vstr(self.symbol, "SNAP_SYMBOL")
        _vint(self.bar_open_time_ms, "SNAP_TIME")
        if self.bar_open_time_ms % TIMEFRAME != 0:
            raise ValueError("SNAP_TIME_NOT_ALIGNED")
        _vbool(self.has_outputs, "SNAP_HAS")
        if type(self.components) is not tuple:
            raise ValueError("SNAP_COMPS_NOT_TUPLE")
        if not self.has_outputs and len(self.components) > 0:
            raise ValueError("SNAP_NO_OUTPUT_BUT_COMPS")
        if self.has_outputs and len(self.components) == 0:
            raise ValueError("SNAP_OUTPUT_BUT_NO_COMPS")
        seen_keys = set()
        for ck, cv in self.components:
            if type(ck) is not str or not ck:
                raise ValueError("SNAP_COMP_KEY_INVALID")
            if ck in seen_keys:
                raise ValueError("SNAP_COMP_KEY_DUPLICATE")
            seen_keys.add(ck)
            if type(cv) is not tuple:
                raise ValueError("SNAP_COMP_VAL_NOT_TUPLE")
            seen_fields = set()
            for fk, fv in cv:
                if type(fk) is not str or not fk:
                    raise ValueError("SNAP_COMP_FIELD_INVALID")
                if fk in seen_fields:
                    raise ValueError("SNAP_COMP_FIELD_DUPLICATE")
                seen_fields.add(fk)
                try:
                    _canonicalize(fv)
                except ValueError:
                    raise
        expected = canonical_sha256(self._snap_payload())
        if self.snapshot_id != expected:
            raise ValueError("SNAP_ID_MISMATCH")

    def _snap_payload(self):
        return {
            "schemaVersion": self.schema_version,
            "strategyId": self.strategy_id, "specId": self.spec_id,
            "parameterId": self.parameter_id, "datasetId": self.dataset_id,
            "symbol": self.symbol, "barOpenTimeMs": self.bar_open_time_ms,
            "hasOutputs": self.has_outputs,
            "components": [[ck, [[fk, fv] for fk,fv in cv]] for ck,cv in self.components],
        }

    def _comp_dict(self):
        return {ck: dict(cv) for ck,cv in self.components}


def create_component_snapshot(*, strategy_id, spec_id, parameter_id, dataset_id, symbol,
                               bar_open_time_ms, has_outputs, component_outputs, component_ids,
                               ) -> Stage5ComponentSnapshot:
    _vstr(strategy_id, "SNAP_FACTORY_STRATEGY")
    _vsha(spec_id, "SNAP_FACTORY_SPEC")
    _vsha(parameter_id, "SNAP_FACTORY_PARAM")
    _vsha(dataset_id, "SNAP_FACTORY_DATASET")
    _vstr(symbol, "SNAP_FACTORY_SYMBOL")
    _vint(bar_open_time_ms, "SNAP_FACTORY_TIME")
    _vbool(has_outputs, "SNAP_FACTORY_HAS")
    if type(component_ids) is not tuple:
        raise ValueError("SNAP_FACTORY_IDS_NOT_TUPLE")
    if len(set(component_ids)) != len(component_ids):
        raise ValueError("SNAP_FACTORY_IDS_DUPLICATE")
    if type(component_outputs) is not dict:
        raise ValueError("SNAP_FACTORY_OUTPUTS_NOT_DICT")
    if not has_outputs:
        if component_outputs:
            raise ValueError("SNAP_FACTORY_NO_OUTPUT_BUT_DATA")
        comps = ()
    else:
        if not component_outputs:
            raise ValueError("SNAP_FACTORY_OUTPUT_BUT_NO_DATA")
        ordered = []
        for cid in component_ids:
            if cid not in component_outputs:
                raise ValueError(f"SNAP_FACTORY_COMP_MISSING:{cid}")
            out = component_outputs[cid]
            if type(out) is not dict:
                raise ValueError(f"SNAP_FACTORY_COMP_NOT_DICT:{cid}")
            canon = _canonicalize(out)
            ordered.append((cid, canon))
        comps = tuple(ordered)
        for cid in component_outputs:
            if cid not in component_ids:
                raise ValueError(f"SNAP_FACTORY_EXTRA_COMP:{cid}")
    payload = {
        "schemaVersion": SNAPSHOT_SCHEMA,
        "strategyId": strategy_id, "specId": spec_id, "parameterId": parameter_id,
        "datasetId": dataset_id, "symbol": symbol,
        "barOpenTimeMs": bar_open_time_ms, "hasOutputs": has_outputs,
        "components": [[ck, [[fk, fv] for fk,fv in cv]] for ck,cv in comps],
    }
    return Stage5ComponentSnapshot(
        schema_version=SNAPSHOT_SCHEMA,
        strategy_id=strategy_id, spec_id=spec_id, parameter_id=parameter_id,
        dataset_id=dataset_id, symbol=symbol,
        bar_open_time_ms=bar_open_time_ms, has_outputs=has_outputs,
        components=comps,
        snapshot_id=canonical_sha256(payload),
    )


@dataclass(frozen=True)
class Stage5ObservationBatch:
    schema_version: str
    strategy_id: str
    frozen_spec_id: str
    spec_id: str
    parameter_id: str
    dataset_id: str
    symbol: str
    scored_start_open_time_ms: int
    scored_end_exclusive_open_time_ms: int
    observations: tuple[Stage5StrategyIntentObservation, ...]
    snapshot_ids: tuple[str, ...]
    batch_id: str

    def __post_init__(self):
        if type(self.schema_version) is not str:
            raise ValueError("BATCH_SCHEMA_NOT_STR")
        if self.schema_version != BATCH_SCHEMA:
            raise ValueError("BATCH_SCHEMA_INVALID")
        _vstr(self.strategy_id, "BATCH_STRATEGY")
        _vsha(self.frozen_spec_id, "BATCH_FROZEN")
        _vsha(self.spec_id, "BATCH_SPEC")
        _vsha(self.parameter_id, "BATCH_PARAM")
        _vsha(self.dataset_id, "BATCH_DATASET")
        _vstr(self.symbol, "BATCH_SYMBOL")
        _vint(self.scored_start_open_time_ms, "BATCH_START")
        _vint(self.scored_end_exclusive_open_time_ms, "BATCH_END")
        if self.scored_start_open_time_ms >= self.scored_end_exclusive_open_time_ms:
            raise ValueError("BATCH_WINDOW_INVALID")
        if self.scored_start_open_time_ms % TIMEFRAME != 0:
            raise ValueError("BATCH_START_NOT_ALIGNED")
        if self.scored_end_exclusive_open_time_ms % TIMEFRAME != 0:
            raise ValueError("BATCH_END_NOT_ALIGNED")
        if type(self.observations) is not tuple:
            raise ValueError("BATCH_OBS_NOT_TUPLE")
        if type(self.snapshot_ids) is not tuple:
            raise ValueError("BATCH_IDS_NOT_TUPLE")
        if len(self.observations) != len(self.snapshot_ids):
            raise ValueError("BATCH_COUNT_MISMATCH")
        expected_count = max(0, (self.scored_end_exclusive_open_time_ms - self.scored_start_open_time_ms)//TIMEFRAME - 1)
        if len(self.observations) != expected_count:
            raise ValueError("BATCH_COUNT_WINDOW_MISMATCH")
        if len(set(self.snapshot_ids)) != len(self.snapshot_ids):
            raise ValueError("BATCH_DUPLICATE_IDS")
        for i,o in enumerate(self.observations):
            if type(o) is not Stage5StrategyIntentObservation:
                raise ValueError(f"BATCH_OBS_TYPE_{i}")
            Stage5StrategyIntentObservation.__post_init__(o)
            exp_time = self.scored_start_open_time_ms + i * TIMEFRAME
            if o.signal_bar_open_time_ms != exp_time:
                raise ValueError(f"BATCH_OBS_TIME_{i}")
            if o.strategy_id != self.strategy_id:
                raise ValueError(f"BATCH_OBS_STRATEGY_{i}")
            if o.spec_id != self.spec_id:
                raise ValueError(f"BATCH_OBS_SPEC_{i}")
            if o.parameter_id != self.parameter_id:
                raise ValueError(f"BATCH_OBS_PARAM_{i}")
            if o.dataset_id != self.dataset_id:
                raise ValueError(f"BATCH_OBS_DATASET_{i}")
            if o.symbol != self.symbol:
                raise ValueError(f"BATCH_OBS_SYMBOL_{i}")
        for i,sid in enumerate(self.snapshot_ids):
            if type(sid) is not str or not _SHA.fullmatch(sid):
                raise ValueError(f"BATCH_ID_INVALID_{i}")
        expected = canonical_sha256(self._batch_payload())
        if self.batch_id != expected:
            raise ValueError("BATCH_ID_MISMATCH")

    def _batch_payload(self):
        return {
            "schemaVersion": self.schema_version,
            "strategyId": self.strategy_id, "frozenSpecId": self.frozen_spec_id,
            "specId": self.spec_id, "parameterId": self.parameter_id,
            "datasetId": self.dataset_id, "symbol": self.symbol,
            "scoredStartOpenTimeMs": self.scored_start_open_time_ms,
            "scoredEndExclusiveOpenTimeMs": self.scored_end_exclusive_open_time_ms,
            "observationIds": [o.observation_id for o in self.observations],
            "snapshotIds": list(self.snapshot_ids),
        }


def produce_observations(*, spec: Stage5FrozenRuleSpec, snapshots: tuple,
                          dataset_id, symbol,
                          scored_start_open_time_ms, scored_end_exclusive_open_time_ms,
                          ) -> Stage5ObservationBatch:
    _vsha(dataset_id, "PROD_DATASET")
    _vstr(symbol, "PROD_SYMBOL")
    _vint(scored_start_open_time_ms, "PROD_START")
    _vint(scored_end_exclusive_open_time_ms, "PROD_END")
    if scored_start_open_time_ms >= scored_end_exclusive_open_time_ms:
        raise ValueError("PROD_WINDOW_INVALID")
    if scored_start_open_time_ms % TIMEFRAME != 0:
        raise ValueError("PROD_START_NOT_ALIGNED")
    if scored_end_exclusive_open_time_ms % TIMEFRAME != 0:
        raise ValueError("PROD_END_NOT_ALIGNED")
    if type(spec) is not Stage5FrozenRuleSpec:
        raise ValueError("PROD_SPEC_TYPE")
    Stage5FrozenRuleSpec.__post_init__(spec)
    if type(snapshots) is not tuple:
        raise ValueError("PROD_SNAPS_NOT_TUPLE")

    expected_count = max(0, (scored_end_exclusive_open_time_ms - scored_start_open_time_ms)//TIMEFRAME - 1)
    if len(snapshots) != expected_count:
        raise ValueError("PROD_COUNT_MISMATCH")

    seen_ids = set()
    obs_list = []
    for i, snap in enumerate(snapshots):
        if type(snap) is not Stage5ComponentSnapshot:
            raise ValueError(f"PROD_SNAP_TYPE_{i}")
        Stage5ComponentSnapshot.__post_init__(snap)
        if snap.snapshot_id in seen_ids:
            raise ValueError(f"PROD_SNAP_DUPLICATE_ID_{i}")
        seen_ids.add(snap.snapshot_id)
        expected_time = scored_start_open_time_ms + i * TIMEFRAME
        if snap.bar_open_time_ms != expected_time:
            raise ValueError(f"PROD_SNAP_TIME_{i}")
        if snap.strategy_id != spec.strategy_id:
            raise ValueError(f"PROD_SNAP_STRATEGY_{i}")
        if snap.spec_id != spec.spec_id:
            raise ValueError(f"PROD_SNAP_SPEC_{i}")
        if snap.parameter_id != spec.parameter_id:
            raise ValueError(f"PROD_SNAP_PARAM_{i}")
        if snap.dataset_id != dataset_id:
            raise ValueError(f"PROD_SNAP_DATASET_{i}")
        if snap.symbol != symbol:
            raise ValueError(f"PROD_SNAP_SYMBOL_{i}")
        if snap.has_outputs:
            if set(c for c,_ in snap.components) != set(spec.components):
                raise ValueError(f"PROD_SNAP_COMPS_{i}")
            # Validate all rule-referenced fields exist
            outputs = snap._comp_dict()
            for rules in (spec.entry_rules, spec.exit_rules):
                for rule in rules:
                    _, _, clauses = rule
                    for comp, field, _, _ in clauses:
                        if comp not in outputs:
                            raise ValueError(f"PROD_COMP_MISSING_{i}:{comp}")
                        if type(outputs[comp]) is not dict:
                            raise ValueError(f"PROD_COMP_NOT_DICT_{i}:{comp}")
                        if field not in outputs[comp]:
                            raise ValueError(f"PROD_FIELD_MISSING_{i}:{comp}.{field}")

        if not snap.has_outputs:
            le = se = lx = sx = False
        else:
            outputs = snap._comp_dict()
            le = any(spec._matches((s,m,c), outputs) for s,m,c in spec.entry_rules if s=="long")
            se = any(spec._matches((s,m,c), outputs) for s,m,c in spec.entry_rules if s=="short")
            lx = any(spec._matches((s,m,c), outputs) for s,m,c in spec.exit_rules if s=="long")
            sx = any(spec._matches((s,m,c), outputs) for s,m,c in spec.exit_rules if s=="short")

        obs_list.append(create_stage5_strategy_intent_observation(
            strategy_id=spec.strategy_id, spec_id=spec.spec_id,
            parameter_id=spec.parameter_id, dataset_id=dataset_id,
            symbol=symbol, signal_bar_open_time_ms=snap.bar_open_time_ms,
            has_outputs=snap.has_outputs,
            long_entry=le, short_entry=se, long_exit=lx, short_exit=sx))

    obs = tuple(obs_list)
    snap_ids = tuple(s.snapshot_id for s in snapshots)
    payload = {
        "schemaVersion": BATCH_SCHEMA,
        "strategyId": spec.strategy_id, "frozenSpecId": spec.frozen_id,
        "specId": spec.spec_id, "parameterId": spec.parameter_id,
        "datasetId": dataset_id, "symbol": symbol,
        "scoredStartOpenTimeMs": scored_start_open_time_ms,
        "scoredEndExclusiveOpenTimeMs": scored_end_exclusive_open_time_ms,
        "observationIds": [o.observation_id for o in obs],
        "snapshotIds": list(snap_ids),
    }
    return Stage5ObservationBatch(
        schema_version=BATCH_SCHEMA,
        strategy_id=spec.strategy_id, frozen_spec_id=spec.frozen_id,
        spec_id=spec.spec_id, parameter_id=spec.parameter_id,
        dataset_id=dataset_id, symbol=symbol,
        scored_start_open_time_ms=scored_start_open_time_ms,
        scored_end_exclusive_open_time_ms=scored_end_exclusive_open_time_ms,
        observations=obs, snapshot_ids=snap_ids,
        batch_id=canonical_sha256(payload),
    )


def verify_observation_batch(*, batch, spec, snapshots, dataset_id, symbol,
                              scored_start_open_time_ms, scored_end_exclusive_open_time_ms,
                              ) -> Stage5ObservationBatch:
    if type(batch) is not Stage5ObservationBatch:
        raise ValueError("VERIFY_BATCH_TYPE")
    Stage5ObservationBatch.__post_init__(batch)
    recomputed = produce_observations(
        spec=spec, snapshots=snapshots, dataset_id=dataset_id, symbol=symbol,
        scored_start_open_time_ms=scored_start_open_time_ms,
        scored_end_exclusive_open_time_ms=scored_end_exclusive_open_time_ms,
    )
    if batch.batch_id != recomputed.batch_id:
        raise ValueError("VERIFY_BATCH_ID_MISMATCH")
    if batch != recomputed:
        raise ValueError("VERIFY_BATCH_CONTENT_MISMATCH")
    return batch
