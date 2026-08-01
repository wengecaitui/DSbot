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


# --- Tagged immutable JSON tree ---

def _freeze(value):
    """Exact-type recursive canonicalizer. Rejects tuple input."""
    if value is None: return ("null",)
    t = type(value)
    if t is bool: return ("bool", value)
    if t is int: return ("int", value)
    if t is float:
        if math.isnan(value) or math.isinf(value): raise ValueError("FREEZE_NAN_INF")
        return ("float", value)
    if t is str: return ("str", value)
    if t is list or t is tuple:
        return ("list",) + tuple(_freeze(v) for v in value)
    if t is dict:
        for k in value:
            if type(k) is not str: raise ValueError("FREEZE_NON_STR_KEY")
        items = tuple(sorted((k, _freeze(v)) for k, v in value.items()))
        return ("dict",) + items
    raise ValueError("FREEZE_UNSUPPORTED_TYPE")


def _validate_frozen_json(node, label=""):
    """Validate tagged JSON tree structure against schema. Returns node if valid."""
    if type(node) is not tuple or len(node) == 0:
        raise ValueError(f"{label}THAW_NOT_TUPLE" if label else "THAW_NOT_TUPLE")
    tag = node[0]
    if type(tag) is not str:
        raise ValueError(f"{label}JSON_TAG_NOT_STR" if label else "JSON_TAG_NOT_STR")
    if tag == "null":
        if len(node) != 1: raise ValueError(f"{label}JSON_NULL_EXTRA" if label else "JSON_NULL_EXTRA")
        return node
    if tag in ("bool","int","str"):
        if len(node) != 2: raise ValueError(f"{label}JSON_{tag.upper()}_LEN" if label else f"JSON_{tag.upper()}_LEN")
        payload = node[1]
        if tag == "bool" and type(payload) is not bool:
            raise ValueError(f"{label}JSON_BOOL_TYPE" if label else "JSON_BOOL_TYPE")
        if tag == "int" and type(payload) is not int:
            raise ValueError(f"{label}JSON_INT_TYPE" if label else "JSON_INT_TYPE")
        if tag == "str" and type(payload) is not str:
            raise ValueError(f"{label}JSON_STR_TYPE" if label else "JSON_STR_TYPE")
        return node
    if tag == "float":
        if len(node) != 2: raise ValueError(f"{label}JSON_FLOAT_LEN" if label else "JSON_FLOAT_LEN")
        payload = node[1]
        if type(payload) is not float: raise ValueError(f"{label}JSON_FLOAT_TYPE" if label else "JSON_FLOAT_TYPE")
        if math.isnan(payload) or math.isinf(payload): raise ValueError(f"{label}JSON_FLOAT_FINITE" if label else "JSON_FLOAT_FINITE")
        return node
    if tag == "list":
        for i, item in enumerate(node[1:]):
            _validate_frozen_json(item, f"{label}L{i}:" if label else f"L{i}:")
        return node
    if tag == "dict":
        entries = node[1:]
        prev = None
        for i, entry in enumerate(entries):
            if type(entry) is not tuple or len(entry) != 2:
                raise ValueError(f"{label}JSON_DICT_ENTRY_INVALID_{i}" if label else f"JSON_DICT_ENTRY_INVALID_{i}")
            k, v = entry
            if type(k) is not str or not k:
                raise ValueError(f"{label}JSON_DICT_KEY_INVALID_{i}" if label else f"JSON_DICT_KEY_INVALID_{i}")
            if prev is not None and k <= prev:
                raise ValueError(f"{label}JSON_DICT_KEY_UNSORTED_{i}" if label else f"JSON_DICT_KEY_UNSORTED_{i}")
            prev = k
            _validate_frozen_json(v, f"{label}D{i}.{k}:" if label else f"D{i}.{k}:")
        return node
    raise ValueError(f"{label}JSON_TAG_UNKNOWN:{tag}" if label else f"JSON_TAG_UNKNOWN:{tag}")


def _thaw_raw(node):
    """Thaw a VALIDATED tagged JSON tree. No validation — caller must validate first."""
    tag = node[0]
    if tag == "null": return None
    if tag == "bool": return node[1]
    if tag == "int": return node[1]
    if tag == "float": return node[1]
    if tag == "str": return node[1]
    if tag == "list": return [_thaw_raw(v) for v in node[1:]]
    if tag == "dict": return {k: _thaw_raw(v) for k, v in node[1:]}
    raise ValueError(f"THAW_UNKNOWN_TAG:{tag}")


def _thaw(node):
    """Validate and thaw a tagged JSON tree."""
    _validate_frozen_json(node)
    return _thaw_raw(node)


# --- Safe comparison (strict type, no loose eq) ---

def _safe_compare(actual, operator, expected):
    if operator == "eq":
        at = type(actual); et = type(expected)
        if at is not et: return False
        if at is float:
            if math.isnan(actual) or math.isnan(expected): return False
        return actual == expected
    at = type(actual); et = type(expected)
    if at is bool or et is bool: raise ValueError("RULE_COMPARE_BOOL")
    if at is not int and at is not float: raise ValueError("RULE_COMPARE_NON_NUMERIC")
    if et is not int and et is not float: raise ValueError("RULE_COMPARE_NON_NUMERIC")
    a = float(actual); e = float(expected)
    if math.isnan(a) or math.isinf(a) or math.isnan(e) or math.isinf(e):
        raise ValueError("RULE_COMPARE_NAN_INF")
    return a >= e if operator == "gte" else a <= e


# --- Shared spec validation ---

def _validate_and_extract_spec(spec_dict, param_dict):
    """Validate complete StrategySpec and return all derived fields. Raises ValueError on any defect."""
    if type(spec_dict) is not dict: raise ValueError("SPEC_DICT_NOT_DICT")
    if type(param_dict) is not dict: raise ValueError("PARAM_DICT_NOT_DICT")

    required = ["strategyId","version","components","entryRules","exitRules",
                "positionLifecycle","riskRules","timeframe","symbols","parameters",
                "warmupBars","executionTiming","costModel","sourceAssetDigests"]
    for key in required:
        if key not in spec_dict: raise ValueError(f"SPEC_MISSING_{key.upper()}")

    sid = spec_dict["strategyId"]
    if type(sid) is not str or not sid: raise ValueError("SPEC_SID_INVALID")
    if not sid.startswith("derived-"): raise ValueError("SPEC_SID_NOT_DERIVED")
    ver = spec_dict["version"]
    if type(ver) is not str or not ver: raise ValueError("SPEC_VER_INVALID")

    # Execution timing
    if spec_dict["executionTiming"] != SUPPORTED_EXECUTION:
        raise ValueError("SPEC_EXEC_INVALID")

    # Timeframe
    tf = spec_dict["timeframe"]
    if type(tf) is not list or not tf: raise ValueError("SPEC_TIMEFRAME_INVALID")
    if len(set(tf)) != len(tf): raise ValueError("SPEC_TIMEFRAME_DUPLICATE")
    for item in tf:
        if type(item) is not str: raise ValueError("SPEC_TIMEFRAME_ITEM_TYPE")
    if "5m" not in tf: raise ValueError("SPEC_NO_5M")

    # Symbols
    symbols = spec_dict["symbols"]
    if type(symbols) is not list or not symbols: raise ValueError("SPEC_SYMBOLS_INVALID")
    if len(set(symbols)) != len(symbols): raise ValueError("SPEC_SYMBOLS_DUPLICATE")
    for item in symbols:
        if type(item) is not str: raise ValueError("SPEC_SYMBOL_ITEM_TYPE")

    # Warmup
    warmup = spec_dict["warmupBars"]
    if type(warmup) is not int or warmup < 2: raise ValueError("SPEC_WARMUP_INVALID")

    # Components
    comps_raw = spec_dict["components"]
    if type(comps_raw) is not list or not comps_raw: raise ValueError("SPEC_COMPS_INVALID")
    components = []
    for ci in comps_raw:
        if type(ci) is not dict: raise ValueError("SPEC_COMP_NOT_DICT")
        aid = ci.get("assetId")
        if type(aid) is not str or not aid: raise ValueError("SPEC_COMP_ID_INVALID")
        pm = ci.get("parameterMap")
        if type(pm) is not dict: raise ValueError("SPEC_COMP_PM_INVALID")
        for pk, pv in pm.items():
            if type(pk) is not str or type(pv) is not str: raise ValueError("SPEC_COMP_PM_TYPE")
        components.append(aid)
    if len(set(components)) != len(components): raise ValueError("SPEC_COMPS_DUPLICATE")

    # Parameters and candidates
    params = spec_dict["parameters"]
    if type(params) is not dict: raise ValueError("SPEC_PARAMS_NOT_DICT")
    if params.get("selectionPolicy") != "explicit-enumeration-only":
        raise ValueError("SPEC_SEL_POLICY_INVALID")
    candidate_sets = params.get("candidateSets")
    if type(candidate_sets) is not list or not candidate_sets: raise ValueError("SPEC_CANDIDATES_INVALID")
    frozen_candidates = []
    for cs in candidate_sets:
        if type(cs) is not dict: raise ValueError("SPEC_CANDIDATE_NOT_DICT")
        fcs = _freeze(cs)
        if fcs in frozen_candidates: raise ValueError("SPEC_CANDIDATE_DUPLICATE")
        frozen_candidates.append(fcs)
    param_frozen = _freeze(param_dict)
    if param_frozen not in frozen_candidates: raise ValueError("SPEC_PARAM_NOT_CANDIDATE")

    # Position lifecycle
    plc = spec_dict["positionLifecycle"]
    if type(plc) is not dict or not plc.get("flatEntry") or not plc.get("reversal"):
        raise ValueError("SPEC_LIFECYCLE_INVALID")

    # Risk rules
    risk = spec_dict["riskRules"]
    if type(risk) is not dict or not risk.get("stopLoss") or not risk.get("takeProfit"):
        raise ValueError("SPEC_RISK_INVALID")

    # Cost model
    if type(spec_dict["costModel"]) is not dict: raise ValueError("SPEC_COST_INVALID")

    # Source asset digests
    digests = spec_dict["sourceAssetDigests"]
    if type(digests) is not dict: raise ValueError("SPEC_DIGESTS_NOT_DICT")
    if set(digests.keys()) != set(components): raise ValueError("SPEC_DIGEST_KEYS_MISMATCH")
    for comp_name in components:
        d = digests[comp_name]
        if type(d) is not dict or not d: raise ValueError(f"SPEC_DIGEST_EMPTY:{comp_name}")
        for v in d.values():
            if type(v) is not str or not _SHA.fullmatch(v): raise ValueError(f"SPEC_DIGEST_SHA:{comp_name}")

    # Rules
    def extract_rules(rules_raw, is_entry):
        if type(rules_raw) is not list or len(rules_raw) == 0:
            raise ValueError("SPEC_ENTRY_RULES_EMPTY" if is_entry else "SPEC_EXIT_RULES_EMPTY")
        rules = []; seen = set()
        for r in rules_raw:
            if type(r) is not dict: raise ValueError("SPEC_RULE_NOT_DICT")
            # Accept only exact keys
            allowed_keys = set()
            if is_entry:
                if "side" not in r: raise ValueError("SPEC_ENTRY_NO_SIDE")
                if "position" in r: raise ValueError("SPEC_ENTRY_HAS_POSITION")
                side = r["side"]
                allowed_keys.add("side")
            else:
                if "position" not in r: raise ValueError("SPEC_EXIT_NO_POSITION")
                if "side" in r: raise ValueError("SPEC_EXIT_HAS_SIDE")
                side = r["position"]
                allowed_keys.add("position")
            if type(side) is not str or side not in ("long","short"):
                raise ValueError("SPEC_RULE_SIDE_INVALID")
            has_all = "all" in r; has_any = "any" in r
            if has_all and has_any: raise ValueError("SPEC_RULE_BOTH_MODES")
            if not has_all and not has_any: raise ValueError("SPEC_RULE_NO_MODE")
            mode = "all" if has_all else "any"
            allowed_keys.add(mode)
            clauses_raw = r[mode]
            if type(clauses_raw) is not list or len(clauses_raw) == 0: raise ValueError("SPEC_CLAUSES_EMPTY")
            extra = set(r.keys()) - allowed_keys
            if extra: raise ValueError(f"SPEC_RULE_EXTRA_KEYS:{extra}")
            parsed = []; seen_clauses = set()
            for c in clauses_raw:
                if type(c) is not dict: raise ValueError("SPEC_CLAUSE_NOT_DICT")
                ckeys = set(c.keys())
                if ckeys != {"component","field","operator","value"}:
                    raise ValueError(f"SPEC_CLAUSE_EXTRA_KEYS:{ckeys-{'component','field','operator','value'}}")
                comp = c["component"]; field = c["field"]
                op = c.get("operator","eq"); val = c["value"]
                if type(comp) is not str or not comp: raise ValueError("SPEC_CLAUSE_COMP_INVALID")
                if type(field) is not str or not field: raise ValueError("SPEC_CLAUSE_FIELD_INVALID")
                if type(op) is not str or op not in ("eq","gte","lte"):
                    raise ValueError("SPEC_CLAUSE_OP_INVALID")
                if comp not in components: raise ValueError(f"SPEC_CLAUSE_COMP_UNKNOWN:{comp}")
                fval = _freeze(val)
                ck = (comp, field, op, fval)
                if ck in seen_clauses: raise ValueError("SPEC_CLAUSE_DUPLICATE")
                seen_clauses.add(ck)
                parsed.append((comp, field, op, fval))
            rule = (side, mode, tuple(parsed))
            if rule in seen: raise ValueError("SPEC_RULE_DUPLICATE")
            seen.add(rule); rules.append(rule)
        return tuple(rules)

    entry_rules = extract_rules(spec_dict["entryRules"], True)
    exit_rules = extract_rules(spec_dict["exitRules"], False)
    spec_id = canonical_sha256(spec_dict)
    param_id = canonical_sha256(param_dict)

    return (sid, ver, spec_id, param_id, tuple(components), tuple(sorted(symbols)),
            entry_rules, exit_rules, warmup)


# --- Frozen Rule Spec ---

@dataclass(frozen=True)
class Stage5FrozenRuleSpec:
    schema_version: str
    spec_payload: tuple
    param_payload: tuple
    strategy_id: str; version: str
    spec_id: str; parameter_id: str
    components: tuple[str, ...]
    symbols: tuple[str, ...]
    entry_rules: tuple[tuple[str, str, tuple[tuple[str, str, str, tuple], ...]], ...]
    exit_rules: tuple[tuple[str, str, tuple[tuple[str, str, str, tuple], ...]], ...]
    warmup_bars: int
    frozen_id: str

    def __post_init__(self):
        if type(self.schema_version) is not str or self.schema_version != RULE_SPEC_SCHEMA:
            raise ValueError("SPEC_SCHEMA_INVALID")
        # Validate payloads
        _validate_frozen_json(self.spec_payload, "SPEC:")
        _validate_frozen_json(self.param_payload, "SPEC_P:")
        if self.spec_payload[0] != "dict": raise ValueError("SPEC_PAYLOAD_NOT_DICT")
        if self.param_payload[0] != "dict": raise ValueError("SPEC_PARAM_NOT_DICT")

        # Validate stored rules (tagged expected values)
        seen = set()
        for rules, is_entry in [(self.entry_rules, True), (self.exit_rules, False)]:
            if type(rules) is not tuple or len(rules)==0:
                raise ValueError("SPEC_ENTRY_EMPTY" if is_entry else "SPEC_EXIT_EMPTY")
            for rule in rules:
                if type(rule) is not tuple or len(rule)!=3: raise ValueError("SPEC_RULE_SHAPE")
                sp, mode, clauses = rule
                if type(sp) is not str: raise ValueError("SPEC_RULE_SIDE_TYPE")
                if type(mode) is not str or mode not in ("all","any"): raise ValueError("SPEC_RULE_MODE_INVALID")
                if is_entry and sp not in ("long","short"): raise ValueError("SPEC_ENTRY_SIDE_INVALID")
                if not is_entry and sp not in ("long","short"): raise ValueError("SPEC_EXIT_POS_INVALID")
                if type(clauses) is not tuple or len(clauses)==0: raise ValueError("SPEC_CLAUSES_EMPTY")
                if rule in seen: raise ValueError("SPEC_RULE_DUPLICATE"); seen.add(rule)
                for c in clauses:
                    if type(c) is not tuple or len(c)!=4: raise ValueError("SPEC_CLAUSE_SHAPE")
                    comp, field, op, val = c
                    if type(comp) is not str or not comp: raise ValueError("SPEC_CLAUSE_COMP_INVALID")
                    if type(field) is not str or not field: raise ValueError("SPEC_CLAUSE_FIELD_INVALID")
                    if type(op) is not str or op not in ("eq","gte","lte"): raise ValueError("SPEC_CLAUSE_OP_INVALID")
                    if type(val) is not tuple: raise ValueError("SPEC_CLAUSE_VAL_NOT_TUPLE")
                    _validate_frozen_json(val, f"CLAUSE:")
                    if val[0] not in ("null","bool","int","float","str"):
                        raise ValueError(f"SPEC_CLAUSE_VAL_COMPOSITE")

        # Re-extract from payloads
        spec_dict = _thaw(self.spec_payload); param_dict = _thaw(self.param_payload)
        extracted = _validate_and_extract_spec(spec_dict, param_dict)
        (e_sid, e_ver, e_spec_id, e_param_id, e_comps, e_syms, e_er, e_xr, e_warmup) = extracted

        if self.strategy_id != e_sid: raise ValueError("SPEC_SID_MISMATCH")
        if self.version != e_ver: raise ValueError("SPEC_VER_MISMATCH")
        if self.spec_id != e_spec_id: raise ValueError("SPEC_ID_MISMATCH")
        if self.parameter_id != e_param_id: raise ValueError("SPEC_PARAM_MISMATCH")
        if self.components != e_comps: raise ValueError("SPEC_COMPS_MISMATCH")
        if self.symbols != e_syms: raise ValueError("SPEC_SYM_MISMATCH")
        if self.entry_rules != e_er: raise ValueError("SPEC_ENTRY_MISMATCH")
        if self.exit_rules != e_xr: raise ValueError("SPEC_EXIT_MISMATCH")
        if self.warmup_bars != e_warmup: raise ValueError("SPEC_WARMUP_MISMATCH")

        # Frozen ID
        fp = _freeze({"schema":RULE_SPEC_SCHEMA,"spec":self.spec_payload,"param":self.param_payload,
                       "specId":self.spec_id,"paramId":self.parameter_id,
                       "components":list(self.components),"symbols":list(self.symbols),
                       "entryRules":[[s,m,[[c,f,o,v] for c,f,o,v in cl]] for s,m,cl in self.entry_rules],
                       "exitRules":[[s,m,[[c,f,o,v] for c,f,o,v in cl]] for s,m,cl in self.exit_rules],
                       "warmupBars":self.warmup_bars})
        expected_fid = canonical_sha256(fp)
        if self.frozen_id != expected_fid: raise ValueError("SPEC_FROZEN_MISMATCH")

    def _matches(self, rule, outputs):
        _, mode, clauses = rule
        checks = []
        for comp, field, op, expected_node in clauses:
            if comp not in outputs: raise ValueError(f"PROD_COMP_MISSING:{comp}")
            comp_out = outputs[comp]
            if type(comp_out) is not dict: raise ValueError(f"PROD_COMP_NOT_DICT:{comp}")
            if field not in comp_out: raise ValueError(f"PROD_FIELD_MISSING:{comp}.{field}")
            actual = comp_out[field]
            expected = _thaw(expected_node)
            checks.append(_safe_compare(actual, op, expected))
        return all(checks) if mode == "all" else any(checks)


def create_frozen_rule_spec(payload: dict, expected_spec_id: str, parameter_set: dict) -> Stage5FrozenRuleSpec:
    if type(payload) is not dict: raise ValueError("FACTORY_PAYLOAD_NOT_DICT")
    if type(expected_spec_id) is not str: raise ValueError("FACTORY_SPEC_ID_NOT_STR")
    if type(parameter_set) is not dict: raise ValueError("FACTORY_PARAM_NOT_DICT")
    if any(type(k) is not str for k in payload): raise ValueError("FACTORY_KEY_NOT_STR")
    if any(type(k) is not str for k in parameter_set): raise ValueError("FACTORY_PARAM_KEY_NOT_STR")

    spec_frozen = _freeze(payload); param_frozen = _freeze(parameter_set)
    spec_dict = _thaw(spec_frozen); param_dict = _thaw(param_frozen)
    extracted = _validate_and_extract_spec(spec_dict, param_dict)
    (sid, ver, spec_id, param_id, comps, syms, er, xr, warmup) = extracted

    if spec_id != expected_spec_id: raise ValueError("FACTORY_SPEC_ID_MISMATCH")

    fp = _freeze({"schema":RULE_SPEC_SCHEMA,"spec":spec_frozen,"param":param_frozen,
                   "specId":spec_id,"paramId":param_id,
                   "components":list(comps),"symbols":list(syms),
                   "entryRules":[[s,m,[[c,f,o,v] for c,f,o,v in cl]] for s,m,cl in er],
                   "exitRules":[[s,m,[[c,f,o,v] for c,f,o,v in cl]] for s,m,cl in xr],
                   "warmupBars":warmup})
    fid = canonical_sha256(fp)

    return Stage5FrozenRuleSpec(
        schema_version=RULE_SPEC_SCHEMA, spec_payload=spec_frozen, param_payload=param_frozen,
        strategy_id=sid, version=ver, spec_id=spec_id, parameter_id=param_id,
        components=comps, symbols=syms, entry_rules=er, exit_rules=xr,
        warmup_bars=warmup, frozen_id=fid,
    )


# --- Component Snapshot ---

@dataclass(frozen=True)
class Stage5ComponentSnapshot:
    schema_version: str; strategy_id: str; spec_id: str; parameter_id: str
    dataset_id: str; symbol: str; bar_open_time_ms: int; has_outputs: bool
    components: tuple; snapshot_id: str

    def __post_init__(self):
        if type(self.schema_version) is not str or self.schema_version != SNAPSHOT_SCHEMA:
            raise ValueError("SNAP_SCHEMA_INVALID")
        _vstr(self.strategy_id, "SNAP_STRATEGY"); _vsha(self.spec_id, "SNAP_SPEC")
        _vsha(self.parameter_id, "SNAP_PARAM"); _vsha(self.dataset_id, "SNAP_DATASET")
        _vstr(self.symbol, "SNAP_SYMBOL")
        _vint(self.bar_open_time_ms, "SNAP_TIME")
        if self.bar_open_time_ms % TIMEFRAME != 0: raise ValueError("SNAP_TIME_NOT_ALIGNED")
        _vbool(self.has_outputs, "SNAP_HAS")
        _validate_frozen_json(self.components, "SNAP:")
        if self.has_outputs:
            if self.components[0] != "dict" or not self.components[1:]:
                raise ValueError("SNAP_OUTPUT_BUT_NO_COMPS")
        else:
            if self.components != ("dict",): raise ValueError("SNAP_NO_OUTPUT_BUT_COMPS")
        snap_dict = _thaw(self.components)
        payload = {"schemaVersion":SNAPSHOT_SCHEMA,"strategyId":self.strategy_id,"specId":self.spec_id,
            "parameterId":self.parameter_id,"datasetId":self.dataset_id,"symbol":self.symbol,
            "barOpenTimeMs":self.bar_open_time_ms,"hasOutputs":self.has_outputs,"components":snap_dict}
        expected = canonical_sha256(payload)
        if self.snapshot_id != expected: raise ValueError("SNAP_ID_MISMATCH")

    def _comp_dict(self): return _thaw(self.components)


def create_component_snapshot(*, spec: Stage5FrozenRuleSpec, dataset_id, symbol,
                               bar_open_time_ms, has_outputs, component_outputs) -> Stage5ComponentSnapshot:
    if type(spec) is not Stage5FrozenRuleSpec: raise ValueError("SNAP_FACTORY_SPEC_TYPE")
    Stage5FrozenRuleSpec.__post_init__(spec)
    _vsha(dataset_id, "SNAP_FACTORY_DATASET"); _vstr(symbol, "SNAP_FACTORY_SYMBOL")
    if symbol not in set(spec.symbols): raise ValueError("SNAP_FACTORY_SYMBOL_NOT_IN_SPEC")
    _vint(bar_open_time_ms, "SNAP_FACTORY_TIME"); _vbool(has_outputs, "SNAP_FACTORY_HAS")
    if type(component_outputs) is not dict: raise ValueError("SNAP_FACTORY_OUTPUTS_NOT_DICT")
    if not has_outputs:
        if component_outputs: raise ValueError("SNAP_FACTORY_NO_OUTPUT_BUT_DATA")
        comps = ("dict",)
    else:
        if not component_outputs: raise ValueError("SNAP_FACTORY_OUTPUT_BUT_NO_DATA")
        if set(component_outputs.keys()) != set(spec.components):
            raise ValueError("SNAP_FACTORY_COMP_KEYS_MISMATCH")
        ordered = {}
        for cid in spec.components:
            out = component_outputs[cid]
            if type(out) is not dict: raise ValueError(f"SNAP_FACTORY_COMP_NOT_DICT:{cid}")
            ordered[cid] = out
        comps = _freeze(ordered)
    payload = {"schemaVersion":SNAPSHOT_SCHEMA,"strategyId":spec.strategy_id,"specId":spec.spec_id,
        "parameterId":spec.parameter_id,"datasetId":dataset_id,"symbol":symbol,
        "barOpenTimeMs":bar_open_time_ms,"hasOutputs":has_outputs,"components":_thaw(comps)}
    return Stage5ComponentSnapshot(schema_version=SNAPSHOT_SCHEMA,strategy_id=spec.strategy_id,
        spec_id=spec.spec_id,parameter_id=spec.parameter_id,dataset_id=dataset_id,symbol=symbol,
        bar_open_time_ms=bar_open_time_ms,has_outputs=has_outputs,components=comps,
        snapshot_id=canonical_sha256(payload))


# --- Observation Batch ---

@dataclass(frozen=True)
class Stage5ObservationBatch:
    schema_version: str; strategy_id: str; frozen_spec_id: str; spec_id: str
    parameter_id: str; dataset_id: str; symbol: str
    scored_start_open_time_ms: int; scored_end_exclusive_open_time_ms: int
    observations: tuple[Stage5StrategyIntentObservation, ...]; snapshot_ids: tuple[str, ...]
    batch_id: str

    def __post_init__(self):
        if type(self.schema_version) is not str or self.schema_version != BATCH_SCHEMA:
            raise ValueError("BATCH_SCHEMA_INVALID")
        _vstr(self.strategy_id,"BATCH_STRATEGY"); _vsha(self.frozen_spec_id,"BATCH_FROZEN")
        _vsha(self.spec_id,"BATCH_SPEC"); _vsha(self.parameter_id,"BATCH_PARAM")
        _vsha(self.dataset_id,"BATCH_DATASET"); _vstr(self.symbol,"BATCH_SYMBOL")
        _vint(self.scored_start_open_time_ms,"BATCH_START")
        _vint(self.scored_end_exclusive_open_time_ms,"BATCH_END")
        if self.scored_start_open_time_ms >= self.scored_end_exclusive_open_time_ms:
            raise ValueError("BATCH_WINDOW_INVALID")
        if self.scored_start_open_time_ms % TIMEFRAME != 0: raise ValueError("BATCH_START_NOT_ALIGNED")
        if self.scored_end_exclusive_open_time_ms % TIMEFRAME != 0: raise ValueError("BATCH_END_NOT_ALIGNED")
        if type(self.observations) is not tuple: raise ValueError("BATCH_OBS_NOT_TUPLE")
        if type(self.snapshot_ids) is not tuple: raise ValueError("BATCH_IDS_NOT_TUPLE")
        if len(self.observations) != len(self.snapshot_ids): raise ValueError("BATCH_COUNT_MISMATCH")
        ec = max(0,(self.scored_end_exclusive_open_time_ms-self.scored_start_open_time_ms)//TIMEFRAME-1)
        if len(self.observations)!=ec: raise ValueError("BATCH_COUNT_WINDOW_MISMATCH")
        if len(set(self.snapshot_ids))!=len(self.snapshot_ids): raise ValueError("BATCH_DUPLICATE_IDS")
        for i,o in enumerate(self.observations):
            if type(o) is not Stage5StrategyIntentObservation: raise ValueError(f"BATCH_OBS_TYPE_{i}")
            Stage5StrategyIntentObservation.__post_init__(o)
            if o.signal_bar_open_time_ms!=self.scored_start_open_time_ms+i*TIMEFRAME: raise ValueError(f"BATCH_OBS_TIME_{i}")
            if o.strategy_id!=self.strategy_id: raise ValueError(f"BATCH_OBS_SID_{i}")
            if o.spec_id!=self.spec_id: raise ValueError(f"BATCH_OBS_SPEC_{i}")
            if o.parameter_id!=self.parameter_id: raise ValueError(f"BATCH_OBS_PARAM_{i}")
            if o.dataset_id!=self.dataset_id: raise ValueError(f"BATCH_OBS_DATASET_{i}")
            if o.symbol!=self.symbol: raise ValueError(f"BATCH_OBS_SYMBOL_{i}")
        for i,sid in enumerate(self.snapshot_ids):
            if type(sid) is not str or not _SHA.fullmatch(sid): raise ValueError(f"BATCH_ID_INVALID_{i}")
        expected = canonical_sha256(self._batch_payload())
        if self.batch_id != expected: raise ValueError("BATCH_ID_MISMATCH")

    def _batch_payload(self):
        return {"schemaVersion":self.schema_version,"strategyId":self.strategy_id,
            "frozenSpecId":self.frozen_spec_id,"specId":self.spec_id,
            "parameterId":self.parameter_id,"datasetId":self.dataset_id,"symbol":self.symbol,
            "scoredStartOpenTimeMs":self.scored_start_open_time_ms,
            "scoredEndExclusiveOpenTimeMs":self.scored_end_exclusive_open_time_ms,
            "observationIds":[o.observation_id for o in self.observations],
            "snapshotIds":list(self.snapshot_ids)}


def produce_observations(*, spec: Stage5FrozenRuleSpec, snapshots: tuple, dataset_id, symbol,
                          scored_start_open_time_ms, scored_end_exclusive_open_time_ms
                          ) -> Stage5ObservationBatch:
    _vsha(dataset_id,"PROD_DATASET"); _vstr(symbol,"PROD_SYMBOL")
    _vint(scored_start_open_time_ms,"PROD_START"); _vint(scored_end_exclusive_open_time_ms,"PROD_END")
    if scored_start_open_time_ms >= scored_end_exclusive_open_time_ms: raise ValueError("PROD_WINDOW_INVALID")
    if scored_start_open_time_ms%TIMEFRAME!=0: raise ValueError("PROD_START_NOT_ALIGNED")
    if scored_end_exclusive_open_time_ms%TIMEFRAME!=0: raise ValueError("PROD_END_NOT_ALIGNED")
    if type(spec) is not Stage5FrozenRuleSpec: raise ValueError("PROD_SPEC_TYPE")
    Stage5FrozenRuleSpec.__post_init__(spec)
    if symbol not in set(spec.symbols): raise ValueError("PROD_SYMBOL_NOT_IN_SPEC")
    if type(snapshots) is not tuple: raise ValueError("PROD_SNAPS_NOT_TUPLE")
    ec = max(0,(scored_end_exclusive_open_time_ms-scored_start_open_time_ms)//TIMEFRAME-1)
    if len(snapshots)!=ec: raise ValueError("PROD_COUNT_MISMATCH")
    seen_ids=set();obs_list=[]
    for i,snap in enumerate(snapshots):
        if type(snap) is not Stage5ComponentSnapshot: raise ValueError(f"PROD_SNAP_TYPE_{i}")
        Stage5ComponentSnapshot.__post_init__(snap)
        if snap.snapshot_id in seen_ids: raise ValueError(f"PROD_SNAP_DUPLICATE_{i}")
        seen_ids.add(snap.snapshot_id)
        if snap.bar_open_time_ms!=scored_start_open_time_ms+i*TIMEFRAME: raise ValueError(f"PROD_SNAP_TIME_{i}")
        if snap.strategy_id!=spec.strategy_id: raise ValueError(f"PROD_SNAP_STRATEGY_{i}")
        if snap.spec_id!=spec.spec_id: raise ValueError(f"PROD_SNAP_SPEC_{i}")
        if snap.parameter_id!=spec.parameter_id: raise ValueError(f"PROD_SNAP_PARAM_{i}")
        if snap.dataset_id!=dataset_id: raise ValueError(f"PROD_SNAP_DATASET_{i}")
        if snap.symbol!=symbol: raise ValueError(f"PROD_SNAP_SYMBOL_{i}")
        if snap.has_outputs:
            if tuple(sorted(_thaw(snap.components).keys()))!=spec.components:
                raise ValueError(f"PROD_SNAP_COMPS_{i}")
            outputs = snap._comp_dict()
            for rules in (spec.entry_rules,spec.exit_rules):
                for rule in rules:
                    for comp,field,_,_ in rule[2]:
                        if comp not in outputs: raise ValueError(f"PROD_COMP_MISSING_{i}:{comp}")
                        if type(outputs[comp]) is not dict: raise ValueError(f"PROD_COMP_NOT_DICT_{i}:{comp}")
                        if field not in outputs[comp]: raise ValueError(f"PROD_FIELD_MISSING_{i}:{comp}.{field}")
        if not snap.has_outputs: le=se=lx=sx=False
        else:
            outputs=snap._comp_dict()
            le=any(spec._matches((s,m,c),outputs) for s,m,c in spec.entry_rules if s=="long")
            se=any(spec._matches((s,m,c),outputs) for s,m,c in spec.entry_rules if s=="short")
            lx=any(spec._matches((s,m,c),outputs) for s,m,c in spec.exit_rules if s=="long")
            sx=any(spec._matches((s,m,c),outputs) for s,m,c in spec.exit_rules if s=="short")
        obs_list.append(create_stage5_strategy_intent_observation(
            strategy_id=spec.strategy_id,spec_id=spec.spec_id,parameter_id=spec.parameter_id,
            dataset_id=dataset_id,symbol=symbol,signal_bar_open_time_ms=snap.bar_open_time_ms,
            has_outputs=snap.has_outputs,long_entry=le,short_entry=se,long_exit=lx,short_exit=sx))
    obs=tuple(obs_list);snap_ids=tuple(s.snapshot_id for s in snapshots)
    payload={"schemaVersion":BATCH_SCHEMA,"strategyId":spec.strategy_id,"frozenSpecId":spec.frozen_id,
        "specId":spec.spec_id,"parameterId":spec.parameter_id,"datasetId":dataset_id,"symbol":symbol,
        "scoredStartOpenTimeMs":scored_start_open_time_ms,"scoredEndExclusiveOpenTimeMs":scored_end_exclusive_open_time_ms,
        "observationIds":[o.observation_id for o in obs],"snapshotIds":list(snap_ids)}
    return Stage5ObservationBatch(schema_version=BATCH_SCHEMA,strategy_id=spec.strategy_id,
        frozen_spec_id=spec.frozen_id,spec_id=spec.spec_id,parameter_id=spec.parameter_id,
        dataset_id=dataset_id,symbol=symbol,scored_start_open_time_ms=scored_start_open_time_ms,
        scored_end_exclusive_open_time_ms=scored_end_exclusive_open_time_ms,observations=obs,
        snapshot_ids=snap_ids,batch_id=canonical_sha256(payload))


def verify_observation_batch(*, batch, spec, snapshots, dataset_id, symbol,
                              scored_start_open_time_ms, scored_end_exclusive_open_time_ms
                              ) -> Stage5ObservationBatch:
    if type(batch) is not Stage5ObservationBatch: raise ValueError("VERIFY_BATCH_TYPE")
    Stage5ObservationBatch.__post_init__(batch)
    r = produce_observations(spec=spec,snapshots=snapshots,dataset_id=dataset_id,symbol=symbol,
        scored_start_open_time_ms=scored_start_open_time_ms,scored_end_exclusive_open_time_ms=scored_end_exclusive_open_time_ms)
    if batch.batch_id != r.batch_id: raise ValueError("VERIFY_BATCH_ID_MISMATCH")
    if batch != r: raise ValueError("VERIFY_BATCH_CONTENT_MISMATCH")
    return batch
