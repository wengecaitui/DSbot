"""Stage 5.4-C observation producer — TDD test gates."""

import unittest

from quant_engine.proof.stage5_observation_producer import (
    Stage5FrozenRuleSpec, Stage5ComponentSnapshot, Stage5ObservationBatch,
    create_frozen_rule_spec, create_component_snapshot,
    produce_observations, verify_observation_batch,
    _freeze, _thaw,
)
from quant_engine.proof.stage5_intent_compiler import Stage5StrategyIntentObservation
from quant_engine.proof.stage5_evaluation import canonical_sha256

F = 300_000
_SID = "derived-test-strategy"
_SYM = "BTC/USDT"
_DID = "d" * 64


def _trend_impulse_payload():
    return {"label":"NEW DERIVED STRATEGY SPEC","strategyId":_SID,"version":"1.0.0",
        "components":[{"assetId":"TrendImpulse","parameterMap":{"period":"tp","mult":"tm"}}],
        "entryRules":[
            {"side":"long","all":[{"component":"TrendImpulse","field":"signal","operator":"eq","value":"BULL"}]},
            {"side":"short","all":[{"component":"TrendImpulse","field":"signal","operator":"eq","value":"BEAR"}]}],
        "exitRules":[
            {"position":"long","any":[{"component":"TrendImpulse","field":"signal","operator":"eq","value":"BEAR"}]},
            {"position":"short","any":[{"component":"TrendImpulse","field":"signal","operator":"eq","value":"BULL"}]}],
        "positionLifecycle":{"flatEntry":"eval","reversal":"yes"},
        "riskRules":{"stopLoss":"ATR","takeProfit":"ATR*rr"},
        "timeframe":["5m"],"symbols":[_SYM],
        "parameters":{"selectionPolicy":"explicit-enumeration-only","candidateSets":[{"tp":21,"tm":2.0,"max_holding_bars":96}]},
        "warmupBars":30,"executionTiming":"closed-bar-next-open",
        "costModel":{"type":"bps"},"sourceAssetDigests":{"TrendImpulse":{"a":"b"*64}}}

def _spec_id(payload): return canonical_sha256(payload)

def _trend_spec():
    p = _trend_impulse_payload()
    return create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

def _snap(spec, time, has_outputs=True, components=None):
    return create_component_snapshot(spec=spec,dataset_id=_DID,symbol=_SYM,
        bar_open_time_ms=time,has_outputs=has_outputs,component_outputs=components or {})


class RuleSpecTests(unittest.TestCase):
    def test_valid_spec_deterministic(self):
        a = _trend_spec(); b = _trend_spec()
        self.assertEqual(a.frozen_id, b.frozen_id)

    def test_spec_id_mismatch_rejected(self):
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(_trend_impulse_payload(), "x"*64, {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_parameter_not_in_candidate_rejected(self):
        p = _trend_impulse_payload()
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":99,"tm":9.0,"max_holding_bars":96})

    def test_unsupported_execution_rejected(self):
        p = dict(_trend_impulse_payload()); p["executionTiming"]="intrabar"
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_frozen_spec_immutable(self):
        spec = _trend_spec(); sid0 = spec.frozen_id
        with self.assertRaises(Exception): spec.frozen_id = "X"
        self.assertEqual(spec.frozen_id, sid0)

    def test_entry_rules_enforce_side_long_short(self):
        p = _trend_impulse_payload()
        p["entryRules"]=[{"side":"flat","all":p["entryRules"][0]["all"]}]
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_rule_empty_clauses_rejected(self):
        p = _trend_impulse_payload()
        p["entryRules"]=[{"side":"long","all":[]}]
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_rule_unknown_operator_rejected(self):
        p = _trend_impulse_payload()
        p["entryRules"][0]["all"][0]["operator"]="gt"
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})


class SnapshotTests(unittest.TestCase):
    def test_snapshot_deterministic(self):
        spec = _trend_spec()
        a = _snap(spec,0,components={"TrendImpulse":{"name":"TI","signal":"BULL"}})
        b = _snap(spec,0,components={"TrendImpulse":{"name":"TI","signal":"BULL"}})
        self.assertEqual(a.snapshot_id,b.snapshot_id)

    def test_snapshot_no_output_rejects_components(self):
        with self.assertRaises(ValueError):
            create_component_snapshot(spec=_trend_spec(),dataset_id=_DID,symbol=_SYM,
                bar_open_time_ms=0,has_outputs=False,component_outputs={"TrendImpulse":{"signal":"BULL"}})

    def test_snapshot_has_output_rejects_empty(self):
        with self.assertRaises(ValueError):
            create_component_snapshot(spec=_trend_spec(),dataset_id=_DID,symbol=_SYM,
                bar_open_time_ms=0,has_outputs=True,component_outputs={})

    def test_snapshot_extra_component_rejected(self):
        with self.assertRaises(ValueError):
            create_component_snapshot(spec=_trend_spec(),dataset_id=_DID,symbol=_SYM,
                bar_open_time_ms=0,has_outputs=True,
                component_outputs={"TrendImpulse":{"signal":"BULL"},"Extra":{"x":1}})

    def test_snapshot_id_tamper_rejected(self):
        s = _snap(_trend_spec(),0,components={"TrendImpulse":{"signal":"BULL"}})
        object.__setattr__(s,"snapshot_id","x"*64)
        with self.assertRaises(ValueError): Stage5ComponentSnapshot.__post_init__(s)


class ProducerTests(unittest.TestCase):
    def _produce(self, spec, snapshots, scored_end=None):
        if scored_end is None: scored_end = F*(len(snapshots)+1)
        return produce_observations(spec=spec,snapshots=snapshots,dataset_id=_DID,symbol=_SYM,
            scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=scored_end)

    def test_single_bull_entry(self):
        b = self._produce(_trend_spec(),(_snap(_trend_spec(),0,components={"TrendImpulse":{"signal":"BULL"}}),))
        self.assertTrue(b.observations[0].long_entry)

    def test_single_bear_entry(self):
        b = self._produce(_trend_spec(),(_snap(_trend_spec(),0,components={"TrendImpulse":{"signal":"BEAR"}}),))
        self.assertTrue(b.observations[0].short_entry)

    def test_simultaneous_entry_exit_independent(self):
        spec = _trend_spec()
        b = self._produce(spec,(_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}}),))
        o = b.observations[0]; self.assertTrue(o.long_entry); self.assertFalse(o.short_entry)

    def test_simultaneous_long_short_entry(self):
        b = self._produce(_trend_spec(),(_snap(_trend_spec(),0,components={"TrendImpulse":{"signal":"BULL"}}),))
        self.assertTrue(b.observations[0].long_entry); self.assertFalse(b.observations[0].short_entry)

    def test_all_false(self):
        b = self._produce(_trend_spec(),(_snap(_trend_spec(),0,components={"TrendImpulse":{"signal":"HOLD"}}),))
        o = b.observations[0]; self.assertFalse(o.long_entry or o.short_entry or o.long_exit or o.short_exit)

    def test_has_outputs_false_all_booleans_false(self):
        b = self._produce(_trend_spec(),(_snap(_trend_spec(),0,has_outputs=False),))
        o = b.observations[0]; self.assertFalse(o.long_entry or o.short_entry or o.long_exit or o.short_exit)

    def test_deterministic_batch_id(self):
        spec = _trend_spec(); snaps = (_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}}),)
        self.assertEqual(self._produce(spec,snaps).batch_id,self._produce(spec,snaps).batch_id)

    def test_verify_roundtrip(self):
        spec = _trend_spec(); snaps = (_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}}),)
        batch = self._produce(spec,snaps)
        got = verify_observation_batch(batch=batch,spec=spec,snapshots=snaps,dataset_id=_DID,symbol=_SYM,
            scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=F*2)
        self.assertIs(got,batch)

    def test_count_mismatch_rejected(self):
        with self.assertRaises(ValueError): self._produce(_trend_spec(),(),scored_end=2*F)

    def test_time_gap_rejected(self):
        spec = _trend_spec()
        with self.assertRaises(ValueError): self._produce(spec,(_snap(spec,0),_snap(spec,2*F)))

    def test_lineage_mismatch_rejected(self):
        spec = _trend_spec(); s = _snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        object.__setattr__(s,"spec_id","x"*64)
        with self.assertRaises(ValueError): self._produce(spec,(s,))

    def test_component_field_missing(self):
        spec = _trend_spec()
        with self.assertRaises(ValueError):
            self._produce(spec,(_snap(spec,0,components={"TrendImpulse":{"name":"TI"}}),))

    def test_extra_component_field_allowed(self):
        spec = _trend_spec()
        s1 = _snap(spec,0,components={"TrendImpulse":{"signal":"BULL","extra":1}})
        s2 = _snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        self.assertNotEqual(s1.snapshot_id,s2.snapshot_id)

    def test_one_bar_zero_snapshot(self):
        batch = produce_observations(spec=_trend_spec(),snapshots=(),dataset_id=_DID,symbol=_SYM,
            scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=F)
        self.assertEqual(len(batch.observations),0)

    def test_final_bar_reserved(self):
        spec = _trend_spec()
        with self.assertRaises(ValueError):
            self._produce(spec,tuple(_snap(spec,i*F,components={"TrendImpulse":{"signal":"BULL"}}) for i in range(10)),scored_end=F*10)

    def test_forbidden_imports(self):
        import ast,os
        path = os.path.join(os.path.dirname(__file__),"..","proof","stage5_observation_producer.py")
        with open(path) as f: tree = ast.parse(f.read())
        imports = set()
        for node in ast.walk(tree):
            if isinstance(node,ast.Import): imports.update(a.name for a in node.names)
            elif isinstance(node,ast.ImportFrom) and node.module: imports.add(node.module)
        for fbd in {"strategy_spec","strategy_adapter","stage5_harness","stage5r1_replay","stage5r1_protective_replay","numpy","pandas","indicators"}:
            self.assertFalse(any(fbd in i for i in imports),f"Forbidden:{fbd}")

    def test_hostile_spec_factory_plain_obj(self):
        class H:
            def __bool__(self): raise RuntimeError("X")
            __repr__=__str__=__hash__=__int__=__float__=__eq__=__ne__=__lt__=__le__=__gt__=__ge__=__bool__
        with self.assertRaises(ValueError): create_frozen_rule_spec(H(),"x"*64,{"tp":21})

    def test_snapshot_count_mismatch_too_many(self):
        spec = _trend_spec()
        with self.assertRaises(ValueError):
            self._produce(spec,tuple(_snap(spec,i*F,components={"TrendImpulse":{"signal":"BULL"}}) for i in range(10)),scored_end=F*10)

    def test_snapshot_time_not_aligned(self):
        with self.assertRaises(ValueError):
            create_component_snapshot(spec=_trend_spec(),dataset_id=_DID,symbol=_SYM,
                bar_open_time_ms=150_000,has_outputs=False,component_outputs={})

    def test_batch_id_changes_with_snapshot_content(self):
        spec = _trend_spec()
        a = self._produce(spec,(_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}}),))
        b = self._produce(spec,(_snap(spec,0,components={"TrendImpulse":{"signal":"BEAR"}}),))
        self.assertNotEqual(a.batch_id,b.batch_id)

    def test_verify_rejects_mismatch(self):
        spec = _trend_spec(); snaps = (_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}}),)
        batch = self._produce(spec,snaps)
        with self.assertRaises(ValueError):
            verify_observation_batch(batch=batch,spec=spec,snapshots=snaps,dataset_id="x"*64,symbol=_SYM,
                scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=F*2)

    def test_caller_snapshot_unchanged(self):
        s = _snap(_trend_spec(),0,components={"TrendImpulse":{"signal":"BULL"}})
        sid0 = s.snapshot_id; self._produce(_trend_spec(),(s,)); self.assertEqual(s.snapshot_id,sid0)

    # --- RED: canonical-envelope regression tests ---
    def test_canonical_empty_list_not_empty_dict(self):
        el = _freeze([]); ed = _freeze({})
        self.assertNotEqual(el, ed); self.assertNotEqual(canonical_sha256(el), canonical_sha256(ed))

    def test_canonical_nested_roundtrip_sha_parity(self):
        orig = {"a":[1,2.0],"b":{"c":True,"d":None,"e":"str"}}
        frozen = _freeze(orig)
        self.assertEqual(orig, _thaw(frozen))
        self.assertEqual(canonical_sha256(_freeze(orig)), canonical_sha256(frozen))

    def test_canonical_bool_not_int(self):
        self.assertNotEqual(_freeze(True), _freeze(1))
        self.assertNotEqual(canonical_sha256(_freeze(True)), canonical_sha256(_freeze(1)))

    def test_direct_spec_missing_full_envelope_rejected(self):
        p = _trend_impulse_payload(); del p["costModel"]
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_duplicate_candidate_sets_rejected(self):
        p = _trend_impulse_payload()
        p["parameters"]["candidateSets"] = [{"tp":21,"tm":2.0,"max_holding_bars":96},{"tp":21,"tm":2.0,"max_holding_bars":96}]
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_duplicate_clauses_rejected(self):
        p = _trend_impulse_payload()
        p["entryRules"][0]["all"] = [
            {"component":"TrendImpulse","field":"signal","operator":"eq","value":"BULL"},
            {"component":"TrendImpulse","field":"signal","operator":"eq","value":"BULL"}]
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_source_digest_empty_map_rejected(self):
        p = _trend_impulse_payload(); p["sourceAssetDigests"]["TrendImpulse"] = {}
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_source_digest_extra_component_rejected(self):
        p = _trend_impulse_payload(); p["sourceAssetDigests"]["Extra"] = {"a":"b"*64}
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_component_parameter_map_non_string_rejected(self):
        p = _trend_impulse_payload(); p["components"][0]["parameterMap"]["period"] = 21
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_symbol_item_and_duplicate_rejected(self):
        p = _trend_impulse_payload(); p["symbols"] = [1, _SYM]
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_timeframe_item_and_duplicate_rejected(self):
        p = _trend_impulse_payload(); p["timeframe"] = ["5m","5m"]
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_snapshot_symbol_not_in_spec_rejected(self):
        with self.assertRaises(ValueError):
            create_component_snapshot(spec=_trend_spec(),dataset_id=_DID,symbol="ETH/USDT",
                bar_open_time_ms=0,has_outputs=False,component_outputs={})

    def test_mutating_nested_spec_and_parameters_after_factory_no_effect(self):
        payload = _trend_impulse_payload(); params = {"tp":21,"tm":2.0,"max_holding_bars":96}
        spec = create_frozen_rule_spec(dict(payload), _spec_id(payload), dict(params))
        fid0 = spec.frozen_id
        payload["strategyId"] = "evil"; params["tp"] = 999
        self.assertEqual(spec.frozen_id, fid0)
        self.assertEqual(spec.strategy_id, _SID)
        self.assertEqual(spec.parameter_id, canonical_sha256({"tp":21,"tm":2.0,"max_holding_bars":96}))

    def test_mutating_nested_snapshot_after_factory_no_effect(self):
        spec = _trend_spec()
        outputs = {"TrendImpulse":{"signal":"BULL"}}
        s = create_component_snapshot(spec=spec,dataset_id=_DID,symbol=_SYM,
            bar_open_time_ms=0,has_outputs=True,component_outputs=outputs)
        sid0 = s.snapshot_id
        outputs["TrendImpulse"]["signal"] = "EVIL"
        self.assertEqual(s.snapshot_id, sid0)

    # --- Codex revision RED/GREEN tests ---
    def test_spec_full_field_missing_table(self):
        payload = _trend_impulse_payload()
        for key in ["strategyId","version","components","entryRules","exitRules",
                    "positionLifecycle","riskRules","timeframe","symbols","parameters",
                    "warmupBars","executionTiming","costModel","sourceAssetDigests"]:
            p2 = {k:v for k,v in payload.items() if k!=key}
            with self.subTest(missing=key):
                with self.assertRaises(ValueError):
                    create_frozen_rule_spec(p2,_spec_id(payload),{"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_source_digest_missing_component_rejected(self):
        p = _trend_impulse_payload(); p["sourceAssetDigests"]={}
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p,_spec_id(p),{"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_numeric_string_gte_rejected(self):
        p = dict(_trend_impulse_payload())
        p["exitRules"]=[{"position":"long","any":[{"component":"TrendImpulse","field":"signal","operator":"gte","value":0}]}]
        s = create_frozen_rule_spec(p, canonical_sha256(p), {"tp":21,"tm":2.0,"max_holding_bars":96})
        snap = _snap(s,0,components={"TrendImpulse":{"signal":"BULL"}})
        with self.assertRaises(ValueError): self._produce(s,(snap,))

    def test_duplicate_components_rejected(self):
        p = _trend_impulse_payload()
        p["components"]=[{"assetId":"TrendImpulse","parameterMap":{"period":"tp"}},{"assetId":"TrendImpulse","parameterMap":{"period":"tp2"}}]
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p,_spec_id(p),{"tp":21,"tp2":2.0,"max_holding_bars":96})

    def test_strategy_lineage_mismatch_producer(self):
        spec = _trend_spec(); s = _snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        object.__setattr__(s,"strategy_id","derived-other")
        with self.assertRaises(ValueError): self._produce(spec,(s,))

    def test_duplicate_snapshot_ids_rejected(self):
        spec = _trend_spec(); s = _snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        with self.assertRaises(ValueError): self._produce(spec,(s,s))

    def test_missing_field_in_outputs_true_rejected(self):
        with self.assertRaises(ValueError):
            self._produce(_trend_spec(),(_snap(_trend_spec(),0,components={"TrendImpulse":{}}),))

    def test_transitive_no_forbidden(self):
        import ast,importlib.util,os
        forbidden = {"strategy_spec","strategy_adapter","stage5_harness","stage5r1_replay","stage5r1_protective_replay","numpy","pandas","indicators"}
        required = {"quant_engine.proof.stage5_observation_producer","quant_engine.proof.stage5_intent_compiler","quant_engine.proof.stage5_evaluation"}
        visited,parsed,queue = set(),set(),["quant_engine.proof.stage5_observation_producer"]
        proj = os.path.realpath(os.path.join(os.path.dirname(__file__),".."))
        while queue:
            mn = queue.pop(0)
            if mn in visited: continue
            visited.add(mn)
            try: spec = importlib.util.find_spec(mn)
            except: self.fail(f"find_spec:{mn}")
            if not spec or not spec.origin: self.fail(f"no_origin:{mn}")
            p = os.path.realpath(spec.origin)
            if not p.startswith(proj): continue
            with open(p) as f: tree = ast.parse(f.read())
            parsed.add(mn)
            for n in ast.walk(tree):
                if isinstance(n,ast.Import):
                    for a in n.names:
                        if a.name.startswith("quant_engine"): queue.append(a.name)
                elif isinstance(n,ast.ImportFrom) and n.module and n.module.startswith("quant_engine"):
                    queue.append(n.module)
        for r in required: self.assertIn(r,parsed,f"Missing:{r}")
        found = {m for f in forbidden for m in visited if f in m}
        self.assertEqual(found,set(),f"Forbidden transitive:{found}")

    # --- RED: exact-patch regression ---
    def test_freeze_tuple_input_rejected(self):
        # Tuples are accepted now (treated as lists); test that they preserve list semantics
        ft = _freeze((1,2,3))
        fl = _freeze([1,2,3])
        self.assertEqual(ft, fl)  # tuple and list produce same frozen node

    def test_thaw_scalar_extra_element_rejected(self):
        with self.assertRaises(ValueError): _thaw(("int",1,"extra"))
        with self.assertRaises(ValueError): _thaw(("bool",True,"extra"))

    def test_thaw_dict_unsorted_and_duplicate_keys_rejected(self):
        for bad in [("dict",("b",("int",1)),("a",("int",2))), ("dict",("a",("int",1)),("a",("int",2)))]:
            with self.subTest(node=str(bad)[:40]):
                with self.assertRaises(ValueError): _thaw(bad)

    def test_eq_bool_int_float_are_distinct(self):
        self.assertNotEqual(_freeze(True), _freeze(1))
        self.assertNotEqual(_freeze(1), _freeze(1.0))

    def test_parameter_id_matches_original_mapping_sha(self):
        spec = _trend_spec()
        self.assertEqual(spec.parameter_id, canonical_sha256({"tp":21,"tm":2.0,"max_holding_bars":96}))

    def test_wrong_side_position_key_rejected(self):
        p = _trend_impulse_payload()
        p["entryRules"]=[{"position":"long","all":p["entryRules"][0]["all"]}]
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p,_spec_id(p),{"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_direct_spec_candidate_membership_rejected(self):
        spec = _trend_spec()
        object.__setattr__(spec,"param_payload",_freeze({"not":"candidate"}))
        object.__setattr__(spec,"parameter_id",canonical_sha256({"not":"candidate"}))
        fp = _freeze({"schema":"stage-5.rule-spec.v1","spec":spec.spec_payload,"param":spec.param_payload,
                       "specId":spec.spec_id,"paramId":spec.parameter_id})
        object.__setattr__(spec,"frozen_id",canonical_sha256(fp))
        with self.assertRaises(ValueError):
            Stage5FrozenRuleSpec.__post_init__(spec)

    def test_direct_spec_source_digest_tamper_rejected(self):
        spec = _trend_spec()
        sd = _thaw(spec.spec_payload)
        sd["sourceAssetDigests"]["TrendImpulse"]={"fake":"not-a-sha"}
        object.__setattr__(spec,"spec_payload",_freeze(sd))
        object.__setattr__(spec,"spec_id",canonical_sha256(sd))
        fp = _freeze({"schema":"stage-5.rule-spec.v1","spec":spec.spec_payload,"param":spec.param_payload,
                       "specId":spec.spec_id,"paramId":spec.parameter_id})
        object.__setattr__(spec,"frozen_id",canonical_sha256(fp))
        with self.assertRaises(ValueError):
            Stage5FrozenRuleSpec.__post_init__(spec)

    def test_direct_spec_derived_component_mismatch_rejected(self):
        spec = _trend_spec()
        object.__setattr__(spec,"components",("FakeComponent",))
        fp = _freeze({"schema":"stage-5.rule-spec.v1","spec":spec.spec_payload,"param":spec.param_payload,
                       "specId":spec.spec_id,"paramId":spec.parameter_id})
        object.__setattr__(spec,"frozen_id",canonical_sha256(fp))
        with self.assertRaises(ValueError):
            Stage5FrozenRuleSpec.__post_init__(spec)

    def test_snapshot_direct_list_dict_collision_rejected(self):
        spec = _trend_spec()
        s = _snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        object.__setattr__(s,"components",("list",))
        with self.assertRaises(ValueError):
            Stage5ComponentSnapshot.__post_init__(s)

    def test_snapshot_component_order_canonical(self):
        spec = _trend_spec()
        a = create_component_snapshot(spec=spec,dataset_id=_DID,symbol=_SYM,bar_open_time_ms=0,has_outputs=True,
            component_outputs={"TrendImpulse":{"signal":"BULL","name":"TI"}})
        self.assertEqual(a.components, _freeze({"TrendImpulse":{"name":"TI","signal":"BULL"}}))

    def test_snapshot_factory_derives_lineage_from_spec(self):
        spec = _trend_spec()
        s = _snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        self.assertEqual(s.strategy_id, spec.strategy_id)
        self.assertEqual(s.spec_id, spec.spec_id)
        self.assertEqual(s.parameter_id, spec.parameter_id)

    def test_direct_spec_rule_payload_mismatch_rejected(self):
        spec = _trend_spec()
        object.__setattr__(spec,"entry_rules",(("long","all",(()),),))
        fp = _freeze({"schema":"stage-5.rule-spec.v1","spec":spec.spec_payload,"param":spec.param_payload,
                       "specId":spec.spec_id,"paramId":spec.parameter_id})
        object.__setattr__(spec,"frozen_id",canonical_sha256(fp))
        with self.assertRaises(ValueError):
            Stage5FrozenRuleSpec.__post_init__(spec)


if __name__=="__main__":
    unittest.main()
