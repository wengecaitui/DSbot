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

    # --- RED: exact-patch regression ---
    def test_freeze_tuple_input_rejected(self):
        with self.assertRaises(ValueError): _freeze((1,2))

    def test_parameter_id_nested_container_parity(self):
        p = dict(_trend_impulse_payload())
        p["parameters"]["candidateSets"]=[{"tp":21,"tm":2.0,"nested":[1,{"k":"v"}],"max_holding_bars":96}]
        sid = canonical_sha256(p)
        spec = create_frozen_rule_spec(p, sid, {"tp":21,"tm":2.0,"nested":[1,{"k":"v"}],"max_holding_bars":96})
        self.assertEqual(spec.parameter_id, canonical_sha256({"tp":21,"tm":2.0,"nested":[1,{"k":"v"}],"max_holding_bars":96}))

    def test_direct_duplicate_rule_rejected_with_recomputed_id(self):
        spec = _trend_spec()
        # Duplicate the first rule
        rules = list(spec.entry_rules)
        rules.append(rules[0])
        object.__setattr__(spec,"entry_rules",tuple(rules))
        from quant_engine.proof.stage5_observation_producer import _frozen_spec_identity_payload
        fid = canonical_sha256(_frozen_spec_identity_payload(spec))
        object.__setattr__(spec,"frozen_id",fid)
        with self.assertRaises(ValueError):
            Stage5FrozenRuleSpec.__post_init__(spec)

    def test_direct_spec_rule_payload_mismatch_rejected(self):
        spec = _trend_spec()
        object.__setattr__(spec,"entry_rules",(("long","all",(()),),))
        # Rule validation happens before frozen_id check
        with self.assertRaises(ValueError):
            Stage5FrozenRuleSpec.__post_init__(spec)

    def test_direct_spec_rule_expected_hostile_rejected(self):
        spec = _trend_spec()
        er = list(spec.entry_rules)
        s,m,cl = er[0]; c,f,o,v = cl[0]
        er[0] = (s,m,((c,f,o,("str","BULL","EXTRA")),))
        object.__setattr__(spec,"entry_rules",tuple(er))
        # Rule validation happens before frozen_id check
        with self.assertRaises(ValueError):
            Stage5FrozenRuleSpec.__post_init__(spec)

    def test_unknown_rule_and_clause_keys_rejected(self):
        p = _trend_impulse_payload()
        p["entryRules"][0]["extra_key"] = "forged"
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p,_spec_id(p),{"tp":21,"tm":2.0,"max_holding_bars":96})

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

    def _recompute_id(self, spec):
        from quant_engine.proof.stage5_observation_producer import _frozen_spec_identity_payload
        object.__setattr__(spec, "frozen_id", canonical_sha256(_frozen_spec_identity_payload(spec)))

    def test_direct_spec_candidate_membership_rejected(self):
        spec = _trend_spec()
        object.__setattr__(spec,"param_payload",_freeze({"not":"candidate"}))
        object.__setattr__(spec,"parameter_id",canonical_sha256({"not":"candidate"}))
        self._recompute_id(spec)
        with self.assertRaises(ValueError):
            Stage5FrozenRuleSpec.__post_init__(spec)

    def test_direct_spec_source_digest_tamper_rejected(self):
        spec = _trend_spec()
        sd = _thaw(spec.spec_payload)
        sd["sourceAssetDigests"]["TrendImpulse"]={"fake":"not-a-sha"}
        object.__setattr__(spec,"spec_payload",_freeze(sd))
        object.__setattr__(spec,"spec_id",canonical_sha256(sd))
        self._recompute_id(spec)
        with self.assertRaises(ValueError):
            Stage5FrozenRuleSpec.__post_init__(spec)

    def test_direct_spec_derived_component_mismatch_rejected(self):
        spec = _trend_spec()
        object.__setattr__(spec,"components",("FakeComponent",))
        self._recompute_id(spec)
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

    # --- 2B.1a: shared import predicate ---
    FORBIDDEN_ROOTS = ["quant_engine.strategy_spec","quant_engine.strategy_adapter",
        "quant_engine.proof.stage5_harness","quant_engine.proof.stage5r1_replay",
        "quant_engine.proof.stage5r1_protective_replay","pandas","numpy","quant_engine.indicators"]

    @staticmethod
    def is_forbidden_module(name, roots=None):
        if roots is None: roots = ProducerTests.FORBIDDEN_ROOTS
        return any(name == r or name.startswith(r+".") for r in roots)

    @staticmethod
    def _resolve_relative(base, level, module):
        if level == 0: return module
        prefix = base.rsplit(".", level)[0] if level > 0 and "." in base else ""
        return f"{prefix}.{module}" if module and prefix else (prefix if not module else module)

    # --- hostile boundary tables ---
    HOSTILE_VALUES = {"list":[[]], "dict":[{}], "bool":[True], "int":[1], "empty_str":[""]}

    def _hostile_item_table(self, field_path):
        """Test field as a list container: p[field] = [val] for each hostile value."""
        for label, values in self.HOSTILE_VALUES.items():
            for val in values:
                with self.subTest(field=field_path, hostile=label):
                    p = _trend_impulse_payload()
                    target = p; parts = field_path.split(".")
                    for seg in parts[:-1]: target = target[seg]
                    target[parts[-1]] = [val]
                    with self.assertRaises(ValueError):
                        create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def _hostile_scalar_table(self, field_path):
        """Test field as a scalar: p[field] = val for each hostile value."""
        for label, values in self.HOSTILE_VALUES.items():
            for val in values:
                with self.subTest(field=field_path, hostile=label):
                    p = _trend_impulse_payload()
                    target = p; parts = field_path.split(".")
                    for seg in parts[:-1]: target = target[seg]
                    target[parts[-1]] = val
                    with self.assertRaises(ValueError):
                        create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_timeframe_item_hostile_table(self):
        self._hostile_item_table("timeframe")

    def test_symbol_item_hostile_table(self):
        self._hostile_item_table("symbols")

    def test_lifecycle_flatEntry_hostile_table(self):
        self._hostile_scalar_table("positionLifecycle.flatEntry")

    def test_lifecycle_reversal_hostile_table(self):
        self._hostile_scalar_table("positionLifecycle.reversal")

    def test_risk_stopLoss_hostile_table(self):
        self._hostile_scalar_table("riskRules.stopLoss")

    def test_risk_takeProfit_hostile_table(self):
        self._hostile_scalar_table("riskRules.takeProfit")

    def test_warmup_hostile_extended(self):
        for val, label in [(True,"bool"),(1.5,"float"),("30","str")]:
            with self.subTest(label=label):
                p = _trend_impulse_payload(); p["warmupBars"] = val
                with self.assertRaises(ValueError):
                    create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    # --- restored 8 exact names from 354d4ad ---
    def test_timeframe_list_item_rejected(self):
        p = _trend_impulse_payload(); p["timeframe"] = [["5m"]]
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_timeframe_dict_item_rejected(self):
        p = _trend_impulse_payload(); p["timeframe"] = [{"x":"5m"}]
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_symbol_list_item_rejected(self):
        p = _trend_impulse_payload(); p["symbols"] = [[_SYM]]
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_lifecycle_flatEntry_hostile_rejected(self):
        p = _trend_impulse_payload(); p["positionLifecycle"]["flatEntry"] = True
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_lifecycle_reversal_hostile_rejected(self):
        p = _trend_impulse_payload(); p["positionLifecycle"]["reversal"] = 1
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_risk_stopLoss_hostile_rejected(self):
        p = _trend_impulse_payload(); p["riskRules"]["stopLoss"] = []
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_risk_takeProfit_hostile_rejected(self):
        p = _trend_impulse_payload(); p["riskRules"]["takeProfit"] = {}
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_warmup_bool_rejected(self):
        p = _trend_impulse_payload(); p["warmupBars"] = True
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p, _spec_id(p), {"tp":21,"tm":2.0,"max_holding_bars":96})

    # --- restored tests from previous revision ---
    def test_eq_strict_type_bool_int_float_str(self):
        self.assertNotEqual(_freeze(True),_freeze(1)); self.assertNotEqual(_freeze(1),_freeze(1.0))

    def test_gte_lte_reject_non_numeric(self):
        from quant_engine.proof.stage5_observation_producer import _safe_compare
        for bad in [(True,0),("0",0),([1],0),({},0)]:
            with self.subTest(v=bad):
                with self.assertRaises(ValueError):_safe_compare(bad[0],"gte",bad[1])
                with self.assertRaises(ValueError):_safe_compare(bad[0],"lte",bad[1])

    def test_gte_numeric_boundary(self):
        from quant_engine.proof.stage5_observation_producer import _safe_compare
        self.assertTrue(_safe_compare(0.5,"gte",0.5)); self.assertFalse(_safe_compare(0.499,"gte",0.5))

    def test_lte_numeric_boundary(self):
        from quant_engine.proof.stage5_observation_producer import _safe_compare
        self.assertTrue(_safe_compare(0.5,"lte",0.5)); self.assertFalse(_safe_compare(0.501,"lte",0.5))

    def test_direct_tamper_fields_fail_closed(self):
        for field in ["strategy_id","spec_payload","warmup_bars","symbols","components","entry_rules"]:
            t = _trend_spec(); object.__setattr__(t,field,{"x":"y"})
            with self.subTest(f=field), self.assertRaises(ValueError):
                Stage5FrozenRuleSpec.__post_init__(t)

    def test_caller_spec_payload_unchanged(self):
        p=_trend_impulse_payload(); orig=dict(p)
        create_frozen_rule_spec(p,_spec_id(p),{"tp":21,"tm":2.0,"max_holding_bars":96})
        self.assertEqual(p,orig)

    def test_caller_param_set_unchanged(self):
        p=_trend_impulse_payload(); ps={"tp":21,"tm":2.0,"max_holding_bars":96}; orig=dict(ps)
        create_frozen_rule_spec(p,_spec_id(p),ps); self.assertEqual(ps,orig)

    def test_caller_outputs_unchanged(self):
        spec=_trend_spec(); out={"TrendImpulse":{"signal":"BULL"}}; orig=dict(out)
        _snap(spec,0,components=out); self.assertEqual(out,orig)

    def test_caller_snapshots_tuple_unchanged(self):
        spec=_trend_spec(); ss=(_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}}),)
        ids=tuple(t.snapshot_id for t in ss); self._produce(spec,ss)
        self.assertEqual(tuple(t.snapshot_id for t in ss),ids)

    def test_batch_id_sensitive_to_frozen_spec_id(self):
        spec=_trend_spec(); snaps=(_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}}),)
        b=produce_observations(spec=spec,snapshots=snaps,dataset_id=_DID,symbol=_SYM,
            scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=F*2)
        object.__setattr__(b,"frozen_spec_id","x"*64)
        with self.assertRaises(ValueError): Stage5ObservationBatch.__post_init__(b)

    # --- import proof tests using shared predicate ---
    def test_forbidden_imports(self):
        import ast,os
        path = os.path.join(os.path.dirname(__file__),"..","proof","stage5_observation_producer.py")
        with open(path) as f: tree = ast.parse(f.read())
        imports = set()
        for node in ast.walk(tree):
            if isinstance(node,ast.Import): imports.update(a.name for a in node.names)
            elif isinstance(node,ast.ImportFrom) and node.module:
                if node.level == 0: imports.add(node.module)
                else:
                    # Resolve relative — base is always the producer module itself
                    resolved = self._resolve_relative("quant_engine.proof.stage5_observation_producer", node.level, node.module)
                    imports.add(resolved)
        for imp in imports:
            self.assertFalse(self.is_forbidden_module(imp), f"Forbidden:{imp}")

    def test_transitive_no_forbidden(self):
        import ast,importlib.util,os
        required = ["quant_engine.proof.stage5_observation_producer","quant_engine.proof.stage5_intent_compiler",
                     "quant_engine.proof.stage5_evaluation"]
        visited,parsed,queue = set(),set(),["quant_engine.proof.stage5_observation_producer"]
        proj = os.path.realpath(os.path.join(os.path.dirname(__file__),".."))
        while queue:
            mn = queue.pop(0)
            if mn in visited: continue
            visited.add(mn)
            try: ms = importlib.util.find_spec(mn)
            except: self.fail(f"find_spec:{mn}")
            if not ms or not ms.origin: self.fail(f"no_origin:{mn}")
            fp = os.path.realpath(ms.origin)
            if not fp.startswith(proj): continue
            with open(fp) as f: tree = ast.parse(f.read())
            parsed.add(mn)
            for n in ast.walk(tree):
                if isinstance(n,ast.Import):
                    for a in n.names: queue.append(a.name)
                elif isinstance(n,ast.ImportFrom) and n.module:
                    if n.level == 0: queue.append(n.module)
                    else:
                        queue.append(self._resolve_relative(mn, n.level, n.module))
        for r in required: self.assertIn(r, parsed, f"missing:{r}")
        for m in visited:
            self.assertFalse(self.is_forbidden_module(m), f"Forbidden:{m}")

    def test_forbidden_root_prefix_matching(self):
        roots = list(self.FORBIDDEN_ROOTS)
        for r in roots:
            self.assertTrue(self.is_forbidden_module(r, roots), f"exact {r}")
            self.assertTrue(self.is_forbidden_module(r+".sub", roots), f"sub {r}")
            self.assertFalse(self.is_forbidden_module(r+"X", roots), f"near {r}X")
        self.assertFalse(self.is_forbidden_module("quant_engine.proof", roots), "prefix")
        self.assertFalse(self.is_forbidden_module("quant_engine.proof.stage5_lifecycle_plan", roots), "benign")

    def test_relative_import_resolver(self):
        self.assertEqual(self._resolve_relative("a.b.c", 0, "d"), "d")
        self.assertEqual(self._resolve_relative("a.b.c", 1, "x"), "a.b.x")
        self.assertEqual(self._resolve_relative("a.b.c", 2, "y"), "a.y")
        self.assertEqual(self._resolve_relative("a.b.c", 1, ""), "a.b")

    def test_hostile_field_total_subcase_count(self):
        self.assertEqual(len(self.HOSTILE_VALUES), 5, "5 hostile labels")
        for label, values in self.HOSTILE_VALUES.items():
            self.assertEqual(len(values), 1, f"1 value for {label}")
        # 6 protected field tables × 5 hostile labels = 30 declared subcases
        self.assertEqual(len(self.HOSTILE_VALUES) * 6, 30)

    def test_all_mode_all_clauses_needed(self):
        from quant_engine.proof.stage5_observation_producer import _safe_compare
        self.assertTrue(_safe_compare("BULL","eq","BULL"))
        self.assertFalse(_safe_compare("BULL","eq","BEAR"))

    def test_any_mode_one_sufficient(self):
        from quant_engine.proof.stage5_observation_producer import _safe_compare
        self.assertTrue(_safe_compare(0.7,"gte",0.5))

    # --- 2B.2: authoritative four-candidate matrix ---
    @staticmethod
    def _load_manifest():
        import json,os
        path = os.path.join(os.path.dirname(__file__),"..","..","docs","releases","stage-4a12-candidate-manifest.json")
        with open(path) as f: return json.load(f)

    def test_manifest_candidate_count_and_spec_ids(self):
        m = self._load_manifest()
        self.assertEqual(m["candidateCount"], 4)
        self.assertEqual(len(m["specs"]), 4)
        expected = {
            ("derived-trend-stochastic-confirmation-ca529176d8c82a01",
             "9c77fe6bb80c79481707e4820ad1493c28cec61c41e156073fe28e9e78eafec6"),
            ("derived-stc-trend-filter-5682c752bef50a0c",
             "139bf050c03982325ab4450a022744f342520b35e1e8971f44e861b11cf4d527"),
            ("derived-mean-reversion-trend-guard-262ffac08c1acf35",
             "58156d6fd0c244449e58bb362c28732688615fa68a4771e4d26b2187ced1babe"),
            ("derived-support-resistance-risk-entry-01ef09c554af0da8",
             "4acc61095aa516bfb5757a5ff615e0fd2560ee07c30028ff4d2fd6b5b6032750"),
        }
        actual = {(s["strategyId"], s["specId"]) for s in m["specs"]}
        self.assertEqual(actual, expected)
        self.assertTrue(all(len(s["parameters"]["candidateSets"]) == 3 for s in m["specs"]))
        for s in m["specs"]:
            for c in s["components"]:
                dig = s["sourceAssetDigests"].get(c["assetId"])
                self.assertIsNotNone(dig, f"missing digest for {c['assetId']}")

    def test_spec_id_matches_canonical_payload(self):
        m = self._load_manifest()
        for s in m["specs"]:
            payload = {k:v for k,v in s.items() if k != "specId"}
            self.assertEqual(canonical_sha256(payload), s["specId"],
                f"specId mismatch for {s['strategyId']}")

    def test_all_12_parameter_bindings(self):
        m = self._load_manifest(); bindings = set(); frozen_ids = set()
        for s in m["specs"]:
            payload = {k:v for k,v in s.items() if k != "specId"}
            expected_comps = tuple(c["assetId"] for c in s["components"])
            expected_symbols = tuple(sorted(s["symbols"]))
            expected_warmup = s["warmupBars"]
            for ps in s["parameters"]["candidateSets"]:
                spec = create_frozen_rule_spec(dict(payload), s["specId"], dict(ps))
                self.assertEqual(spec.strategy_id, s["strategyId"])
                self.assertEqual(spec.spec_id, s["specId"])
                self.assertEqual(spec.parameter_id, canonical_sha256(ps))
                spec2 = create_frozen_rule_spec(dict(payload), s["specId"], dict(ps))
                self.assertEqual(spec.frozen_id, spec2.frozen_id)
                self.assertEqual(spec.components, expected_comps)
                self.assertEqual(spec.symbols, expected_symbols)
                self.assertEqual(spec.warmup_bars, expected_warmup)
                self.assertEqual(_thaw(spec.spec_payload), payload)
                self.assertEqual(_thaw(spec.param_payload), ps)
                self.assertTrue(len(spec.entry_rules) > 0)
                self.assertTrue(len(spec.exit_rules) > 0)
                self.assertEqual(spec.entry_rules, spec2.entry_rules)
                self.assertEqual(spec.exit_rules, spec2.exit_rules)
                bindings.add((spec.strategy_id, spec.parameter_id))
                frozen_ids.add(spec.frozen_id)
        self.assertEqual(len(bindings), 12)
        self.assertEqual(len(frozen_ids), 12)

    def _real_fixture(self, spec_index, param_index, components):
        m = self._load_manifest()
        s = m["specs"][spec_index]
        payload = {k:v for k,v in s.items() if k != "specId"}
        ps = list(s["parameters"]["candidateSets"])[param_index]
        spec = create_frozen_rule_spec(dict(payload), s["specId"], dict(ps))
        snap = _snap(spec, 0, components=components)
        # Determinism: produce twice, verify identical IDs
        batch = self._produce(spec, (snap,))
        batch2 = self._produce(spec, (snap,))
        self.assertEqual(batch.batch_id, batch2.batch_id)
        self.assertEqual(batch.observations[0].observation_id, batch2.observations[0].observation_id)
        self.assertEqual(snap.snapshot_id, _snap(spec, 0, components=components).snapshot_id)
        verified = verify_observation_batch(batch=batch, spec=spec, snapshots=(snap,),
            dataset_id=_DID, symbol=_SYM, scored_start_open_time_ms=0,
            scored_end_exclusive_open_time_ms=F*2)
        self.assertIs(verified, batch)
        return batch.observations[0]

    def test_trend_stochastic_real_output(self):
        o = self._real_fixture(0, 0, {
            "TrendImpulse": {"signal": "BULL", "name": "TI"},
            "StochasticOverlay": {"signal": "BUY", "name": "SO"},
        })
        self.assertTrue(o.long_entry); self.assertFalse(o.short_entry)
        self.assertFalse(o.long_exit); self.assertTrue(o.short_exit)

    def test_stc_trend_real_output(self):
        o = self._real_fixture(1, 0, {
            "STC": {"signal": "BUY", "trend": "BEAR", "name": "STC"},
            "TrendImpulse": {"signal": "BULL", "name": "TI"},
        })
        self.assertTrue(o.long_entry); self.assertFalse(o.short_entry)
        self.assertTrue(o.long_exit); self.assertFalse(o.short_exit)

    def test_mean_reversion_real_output(self):
        o = self._real_fixture(2, 0, {
            "MeanReversion": {"signal": "BUY", "probability": 0.5, "name": "MR"},
            "TrendImpulse": {"signal": "BULL", "name": "TI"},
        })
        self.assertTrue(o.long_entry); self.assertFalse(o.short_entry)
        self.assertTrue(o.long_exit); self.assertTrue(o.short_exit)

    def test_support_resistance_real_output(self):
        o = self._real_fixture(3, 0, {
            "SRRange": {"signal": "BULLISH", "position": "LONG", "name": "SR"},
            "TrendImpulse": {"signal": "BULL", "name": "TI"},
        })
        self.assertTrue(o.long_entry); self.assertFalse(o.short_entry)
        self.assertFalse(o.long_exit); self.assertTrue(o.short_exit)

    def test_all_mode_one_false_rejects_entry(self):
        m = self._load_manifest()
        s = m["specs"][0]; payload = {k:v for k,v in s.items() if k != "specId"}
        ps = list(s["parameters"]["candidateSets"])[0]
        spec = create_frozen_rule_spec(dict(payload), s["specId"], dict(ps))
        snap = _snap(spec, 0, components={
            "TrendImpulse": {"signal": "BULL", "name": "TI"},
            "StochasticOverlay": {"signal": "WATCH", "name": "SO"},
        })
        b = self._produce(spec, (snap,))
        self.assertFalse(b.observations[0].long_entry)
        self.assertTrue(b.observations[0].short_exit)

    def test_any_mode_real_exit_true(self):
        m = self._load_manifest()
        s = m["specs"][2]; payload = {k:v for k,v in s.items() if k != "specId"}
        ps = list(s["parameters"]["candidateSets"])[0]
        spec = create_frozen_rule_spec(dict(payload), s["specId"], dict(ps))
        snap = _snap(spec, 0, components={
            "MeanReversion": {"signal": "BUY", "probability": 0.6, "name": "MR"},
            "TrendImpulse": {"signal": "BULL", "name": "TI"},
        })
        b = self._produce(spec, (snap,))
        self.assertTrue(b.observations[0].long_exit)

    def test_tampered_digest_rejects_spec_id(self):
        import copy
        m = self._load_manifest(); orig = copy.deepcopy(m)
        s = m["specs"][0]; payload = {k:v for k,v in s.items() if k != "specId"}
        payload["sourceAssetDigests"] = copy.deepcopy(payload["sourceAssetDigests"])
        payload["sourceAssetDigests"]["TrendImpulse"]["pineSha256"] = "0"*64
        ps = dict(list(s["parameters"]["candidateSets"])[0])
        with self.assertRaisesRegex(ValueError, "FACTORY_SPEC_ID_MISMATCH"):
            create_frozen_rule_spec(payload, s["specId"], ps)
        self.assertEqual(m, orig)

    # --- 2C: direct-construction adversarial closure ---
    def _fresh_spec(self):
        return _trend_spec()

    def test_direct_spec_schema_rejected(self):
        s=self._fresh_spec(); object.__setattr__(s,"schema_version","bad")
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_spec_strategy_id_rejected(self):
        s=self._fresh_spec(); object.__setattr__(s,"strategy_id","bad")
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_spec_version_rejected(self):
        s=self._fresh_spec(); object.__setattr__(s,"version","")
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_spec_spec_id_mismatch_rejected(self):
        s=self._fresh_spec(); object.__setattr__(s,"spec_id","x"*64)
        self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_spec_parameter_id_mismatch_rejected(self):
        s=self._fresh_spec(); object.__setattr__(s,"parameter_id","x"*64)
        self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_spec_components_rejected(self):
        s=self._fresh_spec(); object.__setattr__(s,"components",("X",))
        self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_spec_symbols_rejected(self):
        s=self._fresh_spec(); object.__setattr__(s,"symbols",("X",))
        self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_spec_entry_rules_empty_rejected(self):
        s=self._fresh_spec(); object.__setattr__(s,"entry_rules",())
        self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_spec_exit_rules_empty_rejected(self):
        s=self._fresh_spec(); object.__setattr__(s,"exit_rules",())
        self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_spec_warmup_rejected(self):
        s=self._fresh_spec(); object.__setattr__(s,"warmup_bars",1)
        self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_snap_schema_rejected(self):
        spec=self._fresh_spec(); snap=_snap(spec,0,has_outputs=False)
        object.__setattr__(snap,"schema_version","bad")
        with self.assertRaises(ValueError):Stage5ComponentSnapshot.__post_init__(snap)

    def test_direct_snap_spec_id_rejected(self):
        spec=self._fresh_spec(); s=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        object.__setattr__(s,"spec_id","x"*64)
        # Self-consistent snapshot may pass post_init; must fail produce_observations
        with self.assertRaises(ValueError):self._produce(spec,(s,))

    def test_direct_snap_symbol_lineage_rejected(self):
        spec=self._fresh_spec(); s=_snap(spec,0,has_outputs=False)
        object.__setattr__(s,"symbol","ETH/USDT")
        with self.assertRaises(ValueError):self._produce(spec,(s,))

    def test_direct_snap_time_not_aligned_rejected(self):
        spec=self._fresh_spec(); s=_snap(spec,0,has_outputs=False)
        object.__setattr__(s,"bar_open_time_ms",150000)
        # Recomputed snapshot_id makes it self-consistent; post_init may accept; produce must reject
        with self.assertRaises(ValueError):self._produce(spec,(s,))

    def test_direct_snap_components_tamper_rejected(self):
        spec=self._fresh_spec(); s=_snap(spec,0,has_outputs=False)
        object.__setattr__(s,"components",("dict",("TrendImpulse",("dict",("signal",("str","BULL"))))))
        object.__setattr__(s,"has_outputs",True)
        # Snapshot is now self-consistent; produce must reject component set
        with self.assertRaises(ValueError):self._produce(spec,(s,))

    def test_direct_batch_frozen_id_rejected(self):
        spec=self._fresh_spec(); snaps=(_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}}),)
        b=produce_observations(spec=spec,snapshots=snaps,dataset_id=_DID,symbol=_SYM,
            scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=F*2)
        object.__setattr__(b,"frozen_spec_id","x"*64)
        with self.assertRaises(ValueError):Stage5ObservationBatch.__post_init__(b)

    def test_direct_batch_dataset_rejected(self):
        spec=self._fresh_spec(); snaps=(_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}}),)
        b=produce_observations(spec=spec,snapshots=snaps,dataset_id=_DID,symbol=_SYM,
            scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=F*2)
        object.__setattr__(b,"dataset_id","e"*64)
        # Self-consistent batch passes post_init; must fail verifier
        with self.assertRaises(ValueError):
            verify_observation_batch(batch=b,spec=spec,snapshots=snaps,dataset_id=_DID,symbol=_SYM,
                scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=F*2)

    def test_direct_batch_observation_order_rejected(self):
        spec=self._fresh_spec()
        s1=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        s2=_snap(spec,F,components={"TrendImpulse":{"signal":"BULL"}})
        b=produce_observations(spec=spec,snapshots=(s1,s2),dataset_id=_DID,symbol=_SYM,
            scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=3*F)
        rev=tuple(reversed(b.observations))
        object.__setattr__(b,"observations",rev)
        with self.assertRaises(ValueError):Stage5ObservationBatch.__post_init__(b)

    def test_batch_identity_sensitivity_table(self):
        import copy
        spec=self._fresh_spec()
        s1=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        s2=_snap(spec,F,components={"TrendImpulse":{"signal":"BULL"}})
        b=produce_observations(spec=spec,snapshots=(s1,s2),dataset_id=_DID,symbol=_SYM,
            scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=3*F)
        payload=b._batch_payload(); bid0=b.batch_id
        mut=copy.deepcopy(payload)
        mut["frozenSpecId"]="0"*64; self.assertNotEqual(canonical_sha256(mut),bid0)
        mut=copy.deepcopy(payload); mut["specId"]="0"*64; self.assertNotEqual(canonical_sha256(mut),bid0)
        mut=copy.deepcopy(payload); mut["parameterId"]="0"*64; self.assertNotEqual(canonical_sha256(mut),bid0)
        mut=copy.deepcopy(payload); mut["datasetId"]="0"*64; self.assertNotEqual(canonical_sha256(mut),bid0)
        mut=copy.deepcopy(payload); mut["symbol"]="X"; self.assertNotEqual(canonical_sha256(mut),bid0)
        mut=copy.deepcopy(payload); mut["scoredStartOpenTimeMs"]=F; self.assertNotEqual(canonical_sha256(mut),bid0)
        mut=copy.deepcopy(payload); mut["scoredEndExclusiveOpenTimeMs"]=4*F; self.assertNotEqual(canonical_sha256(mut),bid0)
        mut=copy.deepcopy(payload); mut["observationIds"][0]="0"*64; self.assertNotEqual(canonical_sha256(mut),bid0)
        mut=copy.deepcopy(payload); mut["observationIds"][1]="0"*64; self.assertNotEqual(canonical_sha256(mut),bid0)
        mut=copy.deepcopy(payload); mut["snapshotIds"][0]="0"*64; self.assertNotEqual(canonical_sha256(mut),bid0)
        mut=copy.deepcopy(payload); mut["snapshotIds"][1]="0"*64; self.assertNotEqual(canonical_sha256(mut),bid0)
        mut=copy.deepcopy(payload); mut["observationIds"].reverse(); self.assertNotEqual(canonical_sha256(mut),bid0)
        mut=copy.deepcopy(payload); mut["snapshotIds"].reverse(); self.assertNotEqual(canonical_sha256(mut),bid0)

    def test_verify_rejects_reversed_snapshot_order(self):
        spec=self._fresh_spec()
        s1=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        s2=_snap(spec,F,components={"TrendImpulse":{"signal":"BULL"}})
        b=produce_observations(spec=spec,snapshots=(s1,s2),dataset_id=_DID,symbol=_SYM,
            scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=3*F)
        with self.assertRaises(ValueError):
            verify_observation_batch(batch=b,spec=spec,snapshots=(s2,s1),dataset_id=_DID,symbol=_SYM,
                scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=3*F)

    # --- 2C: exact subclass rejection ---
    def test_subclass_spec_payload_rejected(self):
        class HD(dict):pass
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(HD(_trend_impulse_payload()),_spec_id(_trend_impulse_payload()),
                {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_subclass_spec_id_rejected(self):
        class HS(str):pass
        p=_trend_impulse_payload()
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p,HS(_spec_id(p)),{"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_subclass_parameter_set_rejected(self):
        class HD(dict):pass
        p=_trend_impulse_payload()
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(p,_spec_id(p),HD({"tp":21,"tm":2.0,"max_holding_bars":96}))

    def test_subclass_snap_outputs_rejected(self):
        class HD(dict):pass
        with self.assertRaises(ValueError):
            _snap(_trend_spec(),0,components=HD({"TrendImpulse":{"signal":"BULL"}}))

    def test_subclass_dataset_id_rejected(self):
        class HS(str):pass
        with self.assertRaises(ValueError):
            create_component_snapshot(spec=self._fresh_spec(),dataset_id=HS(_DID),symbol=_SYM,
                bar_open_time_ms=0,has_outputs=False,component_outputs={})

    def test_subclass_symbol_rejected(self):
        class HS(str):pass
        with self.assertRaises(ValueError):
            create_component_snapshot(spec=self._fresh_spec(),dataset_id=_DID,symbol=HS(_SYM),
                bar_open_time_ms=0,has_outputs=False,component_outputs={})

    def test_subclass_bar_open_time_rejected(self):
        with self.assertRaises(ValueError):
            create_component_snapshot(spec=self._fresh_spec(),dataset_id=_DID,symbol=_SYM,
                bar_open_time_ms=0,has_outputs=1,component_outputs={})

    def test_subclass_producer_snapshots_rejected(self):
        class HL(list):pass
        with self.assertRaises(ValueError):
            produce_observations(spec=self._fresh_spec(),snapshots=HL(),dataset_id=_DID,
                symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=F*2)

    def test_subclass_verifier_batch_rejected(self):
        spec=self._fresh_spec(); s=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        b=produce_observations(spec=spec,snapshots=(s,),dataset_id=_DID,symbol=_SYM,
            scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=F*2)
        class HB:pass
        with self.assertRaises(ValueError):
            verify_observation_batch(batch=HB(),spec=spec,snapshots=(s,),dataset_id=_DID,
                symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=F*2)

    # --- 2C: deep caller immutability ---
    def test_deep_spec_immutability_on_success(self):
        import copy
        p=_trend_impulse_payload(); orig=copy.deepcopy(p)
        ps={"tp":21,"tm":2.0,"max_holding_bars":96}; orig_ps=copy.deepcopy(ps)
        spec=create_frozen_rule_spec(p,_spec_id(p),dict(ps))
        p["strategyId"]="evil"; p["components"][0]["assetId"]="X"
        ps["tp"]=999
        self.assertEqual(_thaw(spec.spec_payload),orig)
        self.assertEqual(_thaw(spec.param_payload),orig_ps)
        self.assertEqual(spec.strategy_id,_SID)

    def test_deep_spec_immutability_on_rejection(self):
        import copy
        p=_trend_impulse_payload(); orig=copy.deepcopy(p)
        ps={"tp":21,"tm":2.0,"max_holding_bars":96}; orig_ps=copy.deepcopy(ps)
        try:create_frozen_rule_spec(p,"x"*64,ps)
        except ValueError:pass
        self.assertEqual(p,orig); self.assertEqual(ps,orig_ps)

    def test_deep_snapshot_immutability(self):
        import copy
        spec=self._fresh_spec()
        out={"TrendImpulse":{"signal":"BULL","name":"TI","nested":[1,2]}};orig=copy.deepcopy(out)
        s=_snap(spec,0,components=out)
        out["TrendImpulse"]["signal"]="EVIL"; out["TrendImpulse"]["nested"][0]=999
        self.assertEqual(_thaw(s.components),orig)

    def test_deep_producer_snapshots_immutability(self):
        import copy
        spec=self._fresh_spec()
        out={"TrendImpulse":{"signal":"BULL"}}; orig_out=copy.deepcopy(out)
        s=_snap(spec,0,components=out); sid0=s.snapshot_id
        ss=(s,)
        self._produce(spec,ss)
        self.assertEqual(s.snapshot_id,sid0)
        self.assertEqual(out,orig_out)


if __name__=="__main__":
    unittest.main()
