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


def _safe_compare(actual, operator, expected):
    if operator == "eq":
        return actual == expected
    if operator == "gte":
        if type(actual) is bool or type(expected) is bool: raise ValueError("RULE_COMPARE_BOOL")
        return float(actual) >= float(expected)
    if operator == "lte":
        if type(actual) is bool or type(expected) is bool: raise ValueError("RULE_COMPARE_BOOL")
        return float(actual) <= float(expected)
    raise ValueError(f"RULE_OPERATOR_INVALID:{operator}")


def _canonicalize(value):
    if value is None or isinstance(value, bool) or isinstance(value, (int, float)):
        if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
            raise ValueError("CANONICAL_NAN_INF")
        if isinstance(value, bool): raise ValueError("CANONICAL_BOOL_AS_VALUE")
        return value
    if isinstance(value, str): return value
    if isinstance(value, (tuple, list)):
        return tuple(_canonicalize(v) for v in value)
    if isinstance(value, dict):
        if any(type(k) is not str for k in value): raise ValueError("CANONICAL_NON_STR_KEY")
        return tuple(sorted((k, _canonicalize(v)) for k, v in value.items()))
    raise ValueError("CANONICAL_UNSUPPORTED_TYPE")


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
        if self.schema_version != RULE_SPEC_SCHEMA: raise ValueError("SPEC_SCHEMA_INVALID")
        _vstr(self.strategy_id, "SPEC_STRATEGY_ID")
        if not self.strategy_id.startswith("derived-"): raise ValueError("SPEC_STRATEGY_ID_INVALID")
        _vstr(self.version, "SPEC_VERSION")
        _vsha(self.spec_id, "SPEC_SPEC_ID")
        _vsha(self.parameter_id, "SPEC_PARAM_ID")
        if type(self.components) is not tuple: raise ValueError("SPEC_COMPONENTS_NOT_TUPLE")
        for c in self.components:
            if type(c) is not str: raise ValueError("SPEC_COMPONENT_ITEM_NOT_STR")
        if type(self.entry_rules) is not tuple: raise ValueError("SPEC_ENTRY_NOT_TUPLE")
        if type(self.exit_rules) is not tuple: raise ValueError("SPEC_EXIT_NOT_TUPLE")
        _vint(self.warmup_bars, "SPEC_WARMUP")
        self._validate_rules(self.entry_rules, is_entry=True)
        self._validate_rules(self.exit_rules, is_entry=False)
        expected = canonical_sha256(self._frozen_payload())
        if self.frozen_id != expected: raise ValueError("SPEC_ID_MISMATCH")

    @staticmethod
    def _validate_rules(rules, is_entry):
        for rule in rules:
            if type(rule) is not tuple or len(rule) != 3: raise ValueError("SPEC_RULE_SHAPE_INVALID")
            side_pos, mode, clauses = rule
            if type(side_pos) is not str: raise ValueError("SPEC_RULE_SIDE_NOT_STR")
            if type(mode) is not str: raise ValueError("SPEC_RULE_MODE_NOT_STR")
            if is_entry and side_pos not in ("long","short"): raise ValueError("SPEC_ENTRY_SIDE_INVALID")
            if not is_entry and side_pos not in ("long","short"): raise ValueError("SPEC_EXIT_POS_INVALID")
            if mode not in ("all","any"): raise ValueError("SPEC_RULE_MODE_INVALID")
            if type(clauses) is not tuple or len(clauses) == 0: raise ValueError("SPEC_CLAUSES_INVALID")
            for c in clauses:
                if type(c) is not tuple or len(c) != 4: raise ValueError("SPEC_CLAUSE_SHAPE_INVALID")
                comp, field, op, val = c
                if type(comp) is not str: raise ValueError("SPEC_CLAUSE_COMP_NOT_STR")
                if type(field) is not str: raise ValueError("SPEC_CLAUSE_FIELD_NOT_STR")
                if type(op) is not str: raise ValueError("SPEC_CLAUSE_OP_NOT_STR")
                if op not in ("eq","gte","lte"): raise ValueError("SPEC_CLAUSE_OP_INVALID")
                try:
                    _canonicalize(val)
                except ValueError: raise

    def _frozen_payload(self):
        return {
            "schemaVersion": self.schema_version,
            "strategyId": self.strategy_id,
            "version": self.version,
            "specId": self.spec_id,
            "parameterId": self.parameter_id,
            "components": list(self.components),
            "entryRules": [[s, m, [[c, f, o, v] for c,f,o,v in cls]] for s,m,cls in self.entry_rules],
            "exitRules": [[s, m, [[c, f, o, v] for c,f,o,v in cls]] for s,m,cls in self.exit_rules],
            "warmupBars": self.warmup_bars,
        }

    def _matches(self, rule, outputs):
        _, mode, clauses = rule
        checks = []
        for comp, field, op, expected in clauses:
            if comp not in outputs: return False
            actual = outputs[comp].get(field)
            try:
                checks.append(_safe_compare(actual, op, expected))
            except ValueError:
                return False
        return all(checks) if mode == "all" else any(checks)


def create_frozen_rule_spec(payload: dict, expected_spec_id: str, parameter_set: dict) -> Stage5FrozenRuleSpec:
    if type(payload) is not dict: raise ValueError("FACTORY_PAYLOAD_NOT_DICT")
    if type(expected_spec_id) is not str: raise ValueError("FACTORY_SPEC_ID_NOT_STR")
    if type(parameter_set) is not dict: raise ValueError("FACTORY_PARAM_NOT_DICT")
    if any(type(k) is not str for k in payload): raise ValueError("FACTORY_KEY_NOT_STR")
    if any(type(k) is not str for k in parameter_set): raise ValueError("FACTORY_PARAM_KEY_NOT_STR")

    sid = payload.get("strategyId")
    _vstr(sid, "FACTORY_STRATEGY_ID")
    if not sid.startswith("derived-"): raise ValueError("FACTORY_STRATEGY_ID_INVALID")
    ver = payload.get("version")
    _vstr(ver, "FACTORY_VERSION")
    exec_timing = payload.get("executionTiming")
    if exec_timing != SUPPORTED_EXECUTION: raise ValueError("FACTORY_EXEC_TIMING_INVALID")
    warmup = payload.get("warmupBars")
    if type(warmup) is not int or warmup < 2: raise ValueError("FACTORY_WARMUP_INVALID")

    components_raw = payload.get("components")
    if type(components_raw) is not list: raise ValueError("FACTORY_COMPONENTS_NOT_LIST")
    components = []
    for ci in components_raw:
        if type(ci) is not dict or type(ci.get("assetId")) is not str: raise ValueError("FACTORY_COMPONENT_INVALID")
        components.append(ci["assetId"])

    def parse_rules(rules_raw, is_entry):
        if type(rules_raw) is not list: raise ValueError("FACTORY_RULES_NOT_LIST")
        rules = []
        for r in rules_raw:
            if type(r) is not dict: raise ValueError("FACTORY_RULE_NOT_DICT")
            side = r.get("side" if is_entry else "position")
            if type(side) is not str: raise ValueError("FACTORY_RULE_SIDE_INVALID")
            if is_entry and side not in ("long","short"): raise ValueError("FACTORY_ENTRY_SIDE_INVALID")
            if not is_entry and side not in ("long","short"): raise ValueError("FACTORY_EXIT_POS_INVALID")
            mode = None; clauses = None
            if "all" in r: mode = "all"; clauses = r["all"]
            elif "any" in r: mode = "any"; clauses = r["any"]
            else: raise ValueError("FACTORY_RULE_MODE_MISSING")
            if type(clauses) is not list or len(clauses)==0: raise ValueError("FACTORY_CLAUSES_INVALID")
            parsed = []
            for c in clauses:
                if type(c) is not dict: raise ValueError("FACTORY_CLAUSE_NOT_DICT")
                comp = c.get("component"); field = c.get("field"); op = c.get("operator","eq"); val = c.get("value")
                if type(comp) is not str: raise ValueError("FACTORY_CLAUSE_COMP_INVALID")
                if type(field) is not str: raise ValueError("FACTORY_CLAUSE_FIELD_INVALID")
                if type(op) is not str or op not in ("eq","gte","lte"): raise ValueError("FACTORY_CLAUSE_OP_INVALID")
                if comp not in components: raise ValueError("FACTORY_CLAUSE_COMP_UNKNOWN")
                try: _canonicalize(val)
                except ValueError: raise
                parsed.append((comp, field, op, val))
            rules.append((side, mode, tuple(parsed)))
        return tuple(rules)

    entry_rules = parse_rules(payload.get("entryRules",[]), True)
    exit_rules = parse_rules(payload.get("exitRules",[]), False)

    params = payload.get("parameters")
    if type(params) is not dict: raise ValueError("FACTORY_PARAMETERS_NOT_DICT")
    candidate_sets = params.get("candidateSets")
    if type(candidate_sets) is not list: raise ValueError("FACTORY_CANDIDATE_SETS_NOT_LIST")
    param_canon = _canonicalize(parameter_set)
    found = False
    for cs in candidate_sets:
        if type(cs) is not dict: raise ValueError("FACTORY_CANDIDATE_NOT_DICT")
        if _canonicalize(cs) == param_canon:
            found = True; break
    if not found: raise ValueError("FACTORY_PARAMETER_NOT_IN_CANDIDATE_SETS")

    spec_payload = dict(payload)
    spec_payload["specId"] = "__skip__"
    computed_spec_id = canonical_sha256(spec_payload)
    computed_spec_payload = {k:v for k,v in spec_payload.items() if k != "specId"}
    computed_spec_id = canonical_sha256(computed_spec_payload)
    if computed_spec_id != expected_spec_id: raise ValueError("FACTORY_SPEC_ID_MISMATCH")

    parameter_id=canonical_sha256(dict(param_canon))

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
        if self.schema_version != SNAPSHOT_SCHEMA: raise ValueError("SNAP_SCHEMA_INVALID")
        _vstr(self.strategy_id, "SNAP_STRATEGY")
        _vsha(self.spec_id, "SNAP_SPEC")
        _vsha(self.parameter_id, "SNAP_PARAM")
        _vsha(self.dataset_id, "SNAP_DATASET")
        _vstr(self.symbol, "SNAP_SYMBOL")
        _vint(self.bar_open_time_ms, "SNAP_TIME")
        if self.bar_open_time_ms % TIMEFRAME != 0: raise ValueError("SNAP_TIME_NOT_ALIGNED")
        _vbool(self.has_outputs, "SNAP_HAS")
        if type(self.components) is not tuple: raise ValueError("SNAP_COMPS_NOT_TUPLE")
        if not self.has_outputs and len(self.components) > 0: raise ValueError("SNAP_NO_OUTPUT_BUT_COMPS")
        if self.has_outputs and len(self.components) == 0: raise ValueError("SNAP_OUTPUT_BUT_NO_COMPS")
        for ck, cv in self.components:
            if type(ck) is not str: raise ValueError("SNAP_COMP_KEY_NOT_STR")
            if type(cv) is not tuple: raise ValueError("SNAP_COMP_VAL_NOT_TUPLE")
            for fk, fv in cv:
                if type(fk) is not str: raise ValueError("SNAP_COMP_FIELD_NOT_STR")
                try: _canonicalize(fv)
                except ValueError: raise
        expected = canonical_sha256(self._snap_payload())
        if self.snapshot_id != expected: raise ValueError("SNAP_ID_MISMATCH")

    def _snap_payload(self):
        return {
            "schemaVersion": self.schema_version,
            "strategyId": self.strategy_id,
            "specId": self.spec_id, "parameterId": self.parameter_id,
            "datasetId": self.dataset_id, "symbol": self.symbol,
            "barOpenTimeMs": self.bar_open_time_ms,
            "hasOutputs": self.has_outputs,
            "components": [[ck, [[fk, fv] for fk, fv in cv]] for ck, cv in self.components],
        }

    def _comp_dict(self):
        return {ck: dict(cv) for ck, cv in self.components}


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
    if type(component_ids) is not tuple: raise ValueError("SNAP_FACTORY_IDS_NOT_TUPLE")
    if type(component_outputs) is not dict: raise ValueError("SNAP_FACTORY_OUTPUTS_NOT_DICT")
    if not has_outputs:
        if component_outputs: raise ValueError("SNAP_FACTORY_NO_OUTPUT_BUT_DATA")
        comps = ()
    else:
        if not component_outputs: raise ValueError("SNAP_FACTORY_OUTPUT_BUT_NO_DATA")
        ordered = []
        for cid in component_ids:
            if cid not in component_outputs: raise ValueError(f"SNAP_FACTORY_COMP_MISSING:{cid}")
            out = component_outputs[cid]
            if type(out) is not dict: raise ValueError(f"SNAP_FACTORY_COMP_NOT_DICT:{cid}")
            canon = _canonicalize(out)
            ordered.append((cid, canon))
        comps = tuple(ordered)
        for cid in component_outputs:
            if cid not in component_ids: raise ValueError(f"SNAP_FACTORY_EXTRA_COMP:{cid}")
    payload = {
        "schemaVersion": SNAPSHOT_SCHEMA,
        "strategyId": strategy_id, "specId": spec_id, "parameterId": parameter_id,
        "datasetId": dataset_id, "symbol": symbol,
        "barOpenTimeMs": bar_open_time_ms, "hasOutputs": has_outputs,
        "components": [[ck, [[fk, fv] for fk, fv in cv]] for ck, cv in comps],
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
    spec_id: str
    parameter_id: str
    dataset_id: str
    symbol: str
    observations: tuple[Stage5StrategyIntentObservation, ...]
    snapshot_ids: tuple[str, ...]
    batch_id: str

    def __post_init__(self):
        if self.schema_version != BATCH_SCHEMA: raise ValueError("BATCH_SCHEMA_INVALID")
        _vsha(self.spec_id, "BATCH_SPEC")
        _vsha(self.parameter_id, "BATCH_PARAM")
        _vsha(self.dataset_id, "BATCH_DATASET")
        _vstr(self.symbol, "BATCH_SYMBOL")
        if type(self.observations) is not tuple: raise ValueError("BATCH_OBS_NOT_TUPLE")
        if type(self.snapshot_ids) is not tuple: raise ValueError("BATCH_IDS_NOT_TUPLE")
        if len(self.observations) != len(self.snapshot_ids): raise ValueError("BATCH_COUNT_MISMATCH")
        for i,o in enumerate(self.observations):
            if type(o) is not Stage5StrategyIntentObservation: raise ValueError(f"BATCH_OBS_TYPE_{i}")
            Stage5StrategyIntentObservation.__post_init__(o)
        for i,sid in enumerate(self.snapshot_ids):
            if type(sid) is not str or not _SHA.fullmatch(sid): raise ValueError(f"BATCH_ID_INVALID_{i}")
        expected = canonical_sha256(self._batch_payload())
        if self.batch_id != expected: raise ValueError("BATCH_ID_MISMATCH")

    def _batch_payload(self):
        return {
            "schemaVersion": self.schema_version,
            "specId": self.spec_id, "parameterId": self.parameter_id,
            "datasetId": self.dataset_id, "symbol": self.symbol,
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
    if scored_start_open_time_ms >= scored_end_exclusive_open_time_ms: raise ValueError("PROD_WINDOW_INVALID")
    if scored_start_open_time_ms % TIMEFRAME != 0: raise ValueError("PROD_START_NOT_ALIGNED")
    if scored_end_exclusive_open_time_ms % TIMEFRAME != 0: raise ValueError("PROD_END_NOT_ALIGNED")
    if type(spec) is not Stage5FrozenRuleSpec: raise ValueError("PROD_SPEC_TYPE")
    Stage5FrozenRuleSpec.__post_init__(spec)
    if type(snapshots) is not tuple: raise ValueError("PROD_SNAPS_NOT_TUPLE")

    expected_count = max(0, (scored_end_exclusive_open_time_ms - scored_start_open_time_ms)//TIMEFRAME - 1)
    if len(snapshots) != expected_count: raise ValueError("PROD_COUNT_MISMATCH")

    obs_list = []
    for i, snap in enumerate(snapshots):
        if type(snap) is not Stage5ComponentSnapshot: raise ValueError(f"PROD_SNAP_TYPE_{i}")
        Stage5ComponentSnapshot.__post_init__(snap)
        expected_time = scored_start_open_time_ms + i * TIMEFRAME
        if snap.bar_open_time_ms != expected_time: raise ValueError(f"PROD_SNAP_TIME_{i}")
        if snap.spec_id != spec.spec_id: raise ValueError(f"PROD_SNAP_SPEC_{i}")
        if snap.parameter_id != spec.parameter_id: raise ValueError(f"PROD_SNAP_PARAM_{i}")
        if snap.dataset_id != dataset_id: raise ValueError(f"PROD_SNAP_DATASET_{i}")
        if snap.symbol != symbol: raise ValueError(f"PROD_SNAP_SYMBOL_{i}")
        if snap.has_outputs:
            if set(c for c,_ in snap.components) != set(spec.components): raise ValueError(f"PROD_SNAP_COMPS_{i}")

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
        "specId": spec.spec_id, "parameterId": spec.parameter_id,
        "datasetId": dataset_id, "symbol": symbol,
        "observationIds": [o.observation_id for o in obs],
        "snapshotIds": list(snap_ids),
    }
    return Stage5ObservationBatch(
        schema_version=BATCH_SCHEMA,
        spec_id=spec.spec_id, parameter_id=spec.parameter_id,
        dataset_id=dataset_id, symbol=symbol,
        observations=obs, snapshot_ids=snap_ids,
        batch_id=canonical_sha256(payload),
    )


def verify_observation_batch(*, batch, spec, snapshots, dataset_id, symbol,
                              scored_start_open_time_ms, scored_end_exclusive_open_time_ms,
                              ) -> Stage5ObservationBatch:
    if type(batch) is not Stage5ObservationBatch: raise ValueError("VERIFY_BATCH_TYPE")
    Stage5ObservationBatch.__post_init__(batch)
    recomputed = produce_observations(
        spec=spec, snapshots=snapshots, dataset_id=dataset_id, symbol=symbol,
        scored_start_open_time_ms=scored_start_open_time_ms,
        scored_end_exclusive_open_time_ms=scored_end_exclusive_open_time_ms,
    )
    if batch.batch_id != recomputed.batch_id: raise ValueError("VERIFY_BATCH_ID_MISMATCH")
    if batch != recomputed: raise ValueError("VERIFY_BATCH_CONTENT_MISMATCH")
    return batch
