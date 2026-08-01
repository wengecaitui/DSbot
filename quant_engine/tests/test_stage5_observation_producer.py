"""Stage 5.4-C observation producer — TDD test gates."""

import unittest
import dataclasses

from quant_engine.proof.stage5_observation_producer import (
    Stage5FrozenRuleSpec, Stage5ComponentSnapshot, Stage5ObservationBatch,
    create_frozen_rule_spec, create_component_snapshot,
    produce_observations, verify_observation_batch,
    _freeze, _thaw, SNAPSHOT_SCHEMA,
)
from quant_engine.proof.stage5_intent_compiler import (
    Stage5StrategyIntentObservation, create_stage5_strategy_intent_observation,
)
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

    def _recompute_snapshot_id(self, snap):
        payload = {"schemaVersion":SNAPSHOT_SCHEMA,"strategyId":snap.strategy_id,
            "specId":snap.spec_id,"parameterId":snap.parameter_id,
            "datasetId":snap.dataset_id,"symbol":snap.symbol,
            "barOpenTimeMs":snap.bar_open_time_ms,"hasOutputs":snap.has_outputs,
            "components":_thaw(snap.components)}
        object.__setattr__(snap, "snapshot_id", canonical_sha256(payload))
        Stage5ComponentSnapshot.__post_init__(snap)

    def _recompute_batch_id(self, batch):
        object.__setattr__(batch, "batch_id", canonical_sha256(batch._batch_payload()))
        Stage5ObservationBatch.__post_init__(batch)

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

    # --- 2C.1: authoritative field route tables ---
    def _fresh_spec(self):
        return _trend_spec()

    SPEC_FIELDS = {"schema_version","spec_payload","param_payload","strategy_id","version",
        "spec_id","parameter_id","components","symbols","entry_rules","exit_rules","warmup_bars","frozen_id"}
    SNAP_FIELDS = {"schema_version","strategy_id","spec_id","parameter_id","dataset_id",
        "symbol","bar_open_time_ms","has_outputs","components","snapshot_id"}
    BATCH_FIELDS = {"schema_version","strategy_id","frozen_spec_id","spec_id","parameter_id",
        "dataset_id","symbol","scored_start_open_time_ms","scored_end_exclusive_open_time_ms",
        "observations","snapshot_ids","batch_id"}

    def test_authoritative_spec_field_table(self):
        import dataclasses
        self.assertEqual({f.name for f in dataclasses.fields(Stage5FrozenRuleSpec)}, self.SPEC_FIELDS,
            "SPEC_FIELDS must match dataclass fields")
        spec=self._fresh_spec(); fid=spec.frozen_id
        # schema_version
        s=self._fresh_spec(); object.__setattr__(s,"schema_version","bad")
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)
        # strategy_id
        s=self._fresh_spec(); object.__setattr__(s,"strategy_id","bad")
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)
        # version
        s=self._fresh_spec(); object.__setattr__(s,"version","")
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)
        # spec_id
        s=self._fresh_spec(); object.__setattr__(s,"spec_id","0"*64); self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)
        # parameter_id
        s=self._fresh_spec(); object.__setattr__(s,"parameter_id","0"*64); self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)
        # components
        s=self._fresh_spec(); object.__setattr__(s,"components",("X",)); self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)
        # symbols
        s=self._fresh_spec(); object.__setattr__(s,"symbols",("X",)); self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)
        # entry_rules — reversed order, valid structure, recomputed frozen_id
        s=self._fresh_spec(); er=list(s.entry_rules); object.__setattr__(s,"entry_rules",tuple(reversed(er)))
        self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)
        # exit_rules
        s=self._fresh_spec(); xr=list(s.exit_rules); object.__setattr__(s,"exit_rules",tuple(reversed(xr)))
        self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)
        # warmup_bars
        s=self._fresh_spec(); object.__setattr__(s,"warmup_bars",1); self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)
        # spec_payload — malformed tagged dict
        s=self._fresh_spec(); object.__setattr__(s,"spec_payload",("list",)); self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)
        # param_payload
        s=self._fresh_spec(); object.__setattr__(s,"param_payload",("list",)); self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)
        # frozen_id
        s=self._fresh_spec(); object.__setattr__(s,"frozen_id","0"*64)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_authoritative_snapshot_route_table(self):
        import copy,dataclasses
        self.assertEqual({f.name for f in dataclasses.fields(Stage5ComponentSnapshot)}, self.SNAP_FIELDS,
            "SNAP_FIELDS must match dataclass fields")
        spec=self._fresh_spec(); snap=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        self.assertTrue(snap.has_outputs)
        self.assertIn("BULL", str(snap.components))
        # schema_version → post_init reject
        s=copy.deepcopy(snap); object.__setattr__(s,"schema_version","bad")
        with self.assertRaises(ValueError):Stage5ComponentSnapshot.__post_init__(s)
        # strategy_id → external reject
        s=copy.deepcopy(snap); object.__setattr__(s,"strategy_id","derived-bad"); self._recompute_snapshot_id(s)
        with self.assertRaises(ValueError):self._produce(spec,(s,))
        # spec_id → external reject
        s=copy.deepcopy(snap); object.__setattr__(s,"spec_id","0"*64); self._recompute_snapshot_id(s)
        with self.assertRaises(ValueError):self._produce(spec,(s,))
        # parameter_id → external reject
        s=copy.deepcopy(snap); object.__setattr__(s,"parameter_id","0"*64); self._recompute_snapshot_id(s)
        with self.assertRaises(ValueError):self._produce(spec,(s,))
        # dataset_id → external reject
        s=copy.deepcopy(snap); object.__setattr__(s,"dataset_id","0"*64); self._recompute_snapshot_id(s)
        with self.assertRaises(ValueError):self._produce(spec,(s,))
        # symbol → external reject
        s=copy.deepcopy(snap); object.__setattr__(s,"symbol","ETH/USDT"); self._recompute_snapshot_id(s)
        with self.assertRaises(ValueError):self._produce(spec,(s,))
        # bar_open_time_ms → external reject
        s=copy.deepcopy(snap); object.__setattr__(s,"bar_open_time_ms",F); self._recompute_snapshot_id(s)
        with self.assertRaises(ValueError):self._produce(spec,(s,))
        # has_outputs → self-consistent alternate accepted (no-output is valid)
        s=copy.deepcopy(snap); object.__setattr__(s,"has_outputs",False)
        object.__setattr__(s,"components",("dict",)); self._recompute_snapshot_id(s)
        Stage5ComponentSnapshot.__post_init__(s)  # self-consistent
        b=self._produce(spec,(s,))  # accepted — produces all-false observations
        self.assertEqual(len(b.observations),1)
        # components → external reject via verifier
        s=copy.deepcopy(snap); s2=_snap(spec,0,components={"TrendImpulse":{"signal":"BEAR"}})
        with self.assertRaises(ValueError):
            verify_observation_batch(batch=self._produce(spec,(snap,)),spec=spec,snapshots=(s2,),
                dataset_id=_DID,symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        # snapshot_id → post_init reject
        s=copy.deepcopy(snap); object.__setattr__(s,"snapshot_id","0"*64)
        with self.assertRaises(ValueError):Stage5ComponentSnapshot.__post_init__(s)

    def test_authoritative_batch_route_table(self):
        import copy,dataclasses
        self.assertEqual({f.name for f in dataclasses.fields(Stage5ObservationBatch)}, self.BATCH_FIELDS,
            "BATCH_FIELDS must match dataclass fields")
        spec=self._fresh_spec(); snap=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        b=produce_observations(spec=spec,snapshots=(snap,),dataset_id=_DID,symbol=_SYM,
            scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        # schema_version, strategy_id, spec_id, parameter_id, dataset_id, symbol, start, end → post_init reject
        for field,val in [("schema_version","bad"),("strategy_id","bad"),
            ("spec_id","0"*64),("parameter_id","0"*64),("dataset_id","0"*64),
            ("symbol","ETH/USDT"),("scored_start_open_time_ms",F),
            ("scored_end_exclusive_open_time_ms",4*F)]:
            b2=copy.deepcopy(b); object.__setattr__(b2,field,val)
            with self.subTest(field=field):
                with self.assertRaises(ValueError):Stage5ObservationBatch.__post_init__(b2)
                # After recompute, post_init still fails due to nested observation/window binding
                object.__setattr__(b2,"batch_id",canonical_sha256(b2._batch_payload()))
                with self.assertRaises(ValueError):Stage5ObservationBatch.__post_init__(b2)
        # frozen_spec_id → external reject
        b2=copy.deepcopy(b); object.__setattr__(b2,"frozen_spec_id","0"*64); self._recompute_batch_id(b2)
        with self.assertRaises(ValueError):
            verify_observation_batch(batch=b2,spec=spec,snapshots=(snap,),dataset_id=_DID,
                symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        # observations — one boolean changed, proper observation_id
        obs0=b.observations[0]
        alt_obs=create_stage5_strategy_intent_observation(strategy_id=obs0.strategy_id,
            spec_id=obs0.spec_id,parameter_id=obs0.parameter_id,dataset_id=obs0.dataset_id,
            symbol=obs0.symbol,signal_bar_open_time_ms=obs0.signal_bar_open_time_ms,
            has_outputs=obs0.has_outputs,long_entry=not obs0.long_entry,short_entry=obs0.short_entry,
            long_exit=obs0.long_exit,short_exit=obs0.short_exit)
        b2=copy.deepcopy(b); object.__setattr__(b2,"observations",(alt_obs,))
        self._recompute_batch_id(b2)
        with self.assertRaises(ValueError):
            verify_observation_batch(batch=b2,spec=spec,snapshots=(snap,),dataset_id=_DID,
                symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        # snapshot_ids — valid SHA replacement → external reject
        b2=copy.deepcopy(b); object.__setattr__(b2,"snapshot_ids",("0"*64,)); self._recompute_batch_id(b2)
        with self.assertRaises(ValueError):
            verify_observation_batch(batch=b2,spec=spec,snapshots=(snap,),dataset_id=_DID,
                symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        # batch_id — tamper
        b2=copy.deepcopy(b); object.__setattr__(b2,"batch_id","0"*64)
        with self.assertRaises(ValueError):Stage5ObservationBatch.__post_init__(b2)

    # --- preserved 2C names with proper SHA ---
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
        s=self._fresh_spec(); object.__setattr__(s,"spec_id","0"*64); self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_spec_parameter_id_mismatch_rejected(self):
        s=self._fresh_spec(); object.__setattr__(s,"parameter_id","0"*64); self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_spec_components_rejected(self):
        s=self._fresh_spec(); object.__setattr__(s,"components",("X",)); self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_spec_symbols_rejected(self):
        s=self._fresh_spec(); object.__setattr__(s,"symbols",("X",)); self._recompute_id(s)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_spec_entry_rules_empty_rejected(self):
        s=self._fresh_spec(); object.__setattr__(s,"entry_rules",())
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_spec_exit_rules_empty_rejected(self):
        s=self._fresh_spec(); object.__setattr__(s,"exit_rules",())
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_spec_warmup_rejected(self):
        s=self._fresh_spec(); object.__setattr__(s,"warmup_bars",1)
        with self.assertRaises(ValueError):Stage5FrozenRuleSpec.__post_init__(s)

    def test_direct_snap_schema_rejected(self):
        s=_snap(self._fresh_spec(),0,has_outputs=False)
        object.__setattr__(s,"schema_version","bad")
        with self.assertRaises(ValueError):Stage5ComponentSnapshot.__post_init__(s)

    def test_direct_snap_spec_id_rejected(self):
        spec=self._fresh_spec(); s=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        object.__setattr__(s,"spec_id","0"*64); self._recompute_snapshot_id(s)
        with self.assertRaises(ValueError):self._produce(spec,(s,))

    def test_direct_snap_symbol_lineage_rejected(self):
        spec=self._fresh_spec(); s=_snap(spec,0,has_outputs=True,components={"TrendImpulse":{"signal":"BULL"}})
        object.__setattr__(s,"symbol","ETH/USDT"); self._recompute_snapshot_id(s)
        with self.assertRaises(ValueError):self._produce(spec,(s,))

    def test_direct_snap_time_not_aligned_rejected(self):
        spec=self._fresh_spec(); s=_snap(spec,0,has_outputs=False)
        object.__setattr__(s,"bar_open_time_ms",F); self._recompute_snapshot_id(s)
        with self.assertRaises(ValueError):self._produce(spec,(s,))

    def test_direct_snap_components_tamper_rejected(self):
        spec=self._fresh_spec(); s=_snap(spec,0,has_outputs=True,components={"TrendImpulse":{"signal":"BULL"}})
        s2=_snap(spec,0,components={"TrendImpulse":{"signal":"BEAR"}})
        with self.assertRaises(ValueError):
            verify_observation_batch(batch=self._produce(spec,(s,)),spec=spec,snapshots=(s2,),
                dataset_id=_DID,symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)

    def test_direct_batch_frozen_id_rejected(self):
        spec=self._fresh_spec(); snap=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        b=produce_observations(spec=spec,snapshots=(snap,),dataset_id=_DID,symbol=_SYM,
            scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        object.__setattr__(b,"frozen_spec_id","0"*64); self._recompute_batch_id(b)
        with self.assertRaises(ValueError):
            verify_observation_batch(batch=b,spec=spec,snapshots=(snap,),dataset_id=_DID,
                symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)

    def test_direct_batch_dataset_rejected(self):
        spec=self._fresh_spec(); snap=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        b=produce_observations(spec=spec,snapshots=(snap,),dataset_id=_DID,symbol=_SYM,
            scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        object.__setattr__(b,"dataset_id","0"*64)
        with self.assertRaises(ValueError):
            verify_observation_batch(batch=b,spec=spec,snapshots=(snap,),dataset_id=_DID,
                symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)

    def test_direct_batch_observation_order_rejected(self):
        spec=self._fresh_spec(); s1=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        s2=_snap(spec,F,components={"TrendImpulse":{"signal":"BULL"}})
        b=produce_observations(spec=spec,snapshots=(s1,s2),dataset_id=_DID,symbol=_SYM,
            scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=3*F)
        rev=tuple(reversed(b.observations))
        object.__setattr__(b,"observations",rev)
        with self.assertRaises(ValueError):Stage5ObservationBatch.__post_init__(b)

    def test_batch_identity_sensitivity_table(self):
        import copy
        spec=self._fresh_spec(); s1=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        s2=_snap(spec,F,components={"TrendImpulse":{"signal":"BULL"}})
        b=produce_observations(spec=spec,snapshots=(s1,s2),dataset_id=_DID,symbol=_SYM,
            scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=3*F)
        payload=b._batch_payload(); bid0=b.batch_id
        for mut_val in [{"frozenSpecId":"0"*64},{"specId":"0"*64},{"parameterId":"0"*64},
            {"datasetId":"0"*64},{"symbol":"X"},{"scoredStartOpenTimeMs":F},
            {"scoredEndExclusiveOpenTimeMs":4*F}]:
            mut=copy.deepcopy(payload); mut.update(mut_val); self.assertNotEqual(canonical_sha256(mut),bid0)
        for i in [0,1]:
            mut=copy.deepcopy(payload); mut["observationIds"][i]="0"*64; self.assertNotEqual(canonical_sha256(mut),bid0)
            mut=copy.deepcopy(payload); mut["snapshotIds"][i]="0"*64; self.assertNotEqual(canonical_sha256(mut),bid0)
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
        with self.assertRaisesRegex(ValueError, "FACTORY_PAYLOAD_NOT_DICT"):
            create_frozen_rule_spec(HD(_trend_impulse_payload()),_spec_id(_trend_impulse_payload()),
                {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_subclass_spec_id_rejected(self):
        class HS(str):pass
        p=_trend_impulse_payload()
        with self.assertRaisesRegex(ValueError, "FACTORY_SPEC_ID_NOT_STR"):
            create_frozen_rule_spec(p,HS(_spec_id(p)),{"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_subclass_parameter_set_rejected(self):
        class HD(dict):pass
        p=_trend_impulse_payload()
        with self.assertRaisesRegex(ValueError, "FACTORY_PARAM_NOT_DICT"):
            create_frozen_rule_spec(p,_spec_id(p),HD({"tp":21,"tm":2.0,"max_holding_bars":96}))

    def test_subclass_dataset_id_rejected(self):
        class HS(str):pass
        spec=self._fresh_spec(); s=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        with self.subTest(route="create_component_snapshot"):
            with self.assertRaisesRegex(ValueError,"SNAP_FACTORY_DATASET_MALFORMED"):
                create_component_snapshot(spec=spec,dataset_id=HS(_DID),symbol=_SYM,
                    bar_open_time_ms=0,has_outputs=False,component_outputs={})
        with self.subTest(route="produce_observations"):
            with self.assertRaisesRegex(ValueError,"PROD_DATASET_MALFORMED"):
                produce_observations(spec=spec,snapshots=(s,),dataset_id=HS(_DID),
                    symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)

    def test_subclass_symbol_rejected(self):
        class HS(str):pass
        spec=self._fresh_spec(); s=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        with self.subTest(route="create_component_snapshot"):
            with self.assertRaisesRegex(ValueError,"SNAP_FACTORY_SYMBOL_NOT_STRING"):
                create_component_snapshot(spec=spec,dataset_id=_DID,symbol=HS(_SYM),
                    bar_open_time_ms=0,has_outputs=False,component_outputs={})
        with self.subTest(route="produce_observations"):
            with self.assertRaisesRegex(ValueError,"PROD_SYMBOL_NOT_STRING"):
                produce_observations(spec=spec,snapshots=(s,),dataset_id=_DID,
                    symbol=HS(_SYM),scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)

    def test_subclass_bar_open_time_rejected(self):
        class HInt(int):pass
        spec=self._fresh_spec(); s=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        with self.subTest(route="create_component_snapshot"):
            with self.assertRaisesRegex(ValueError,"SNAP_FACTORY_TIME_NOT_INT"):
                create_component_snapshot(spec=spec,dataset_id=_DID,symbol=_SYM,
                    bar_open_time_ms=HInt(0),has_outputs=False,component_outputs={})
        with self.subTest(route="producer_start"):
            with self.assertRaisesRegex(ValueError,"PROD_START_NOT_INT"):
                produce_observations(spec=spec,snapshots=(s,),dataset_id=_DID,
                    symbol=_SYM,scored_start_open_time_ms=HInt(0),scored_end_exclusive_open_time_ms=2*F)
        with self.subTest(route="producer_end"):
            with self.assertRaisesRegex(ValueError,"PROD_END_NOT_INT"):
                produce_observations(spec=spec,snapshots=(s,),dataset_id=_DID,
                    symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=HInt(2*F))

    def test_subclass_snap_outputs_rejected(self):
        class HD(dict):pass
        with self.subTest(route="component_outputs"):
            with self.assertRaisesRegex(ValueError,"SNAP_FACTORY_OUTPUTS_NOT_DICT"):
                create_component_snapshot(spec=self._fresh_spec(),dataset_id=_DID,symbol=_SYM,
                    bar_open_time_ms=0,has_outputs=False,component_outputs=HD({}))
        with self.subTest(route="has_outputs_non_bool"):
            with self.assertRaisesRegex(ValueError,"SNAP_FACTORY_HAS_NOT_BOOL"):
                create_component_snapshot(spec=self._fresh_spec(),dataset_id=_DID,symbol=_SYM,
                    bar_open_time_ms=0,has_outputs=1,component_outputs={})
        with self.subTest(route="spec_object_subclass"):
            class HSpec(Stage5FrozenRuleSpec):pass
            spec=self._fresh_spec(); vals={f.name:getattr(spec,f.name) for f in dataclasses.fields(Stage5FrozenRuleSpec)}
            with self.assertRaisesRegex(ValueError,"SNAP_FACTORY_SPEC_TYPE"):
                create_component_snapshot(spec=HSpec(**vals),dataset_id=_DID,symbol=_SYM,
                    bar_open_time_ms=0,has_outputs=False,component_outputs={})
        with self.subTest(route="producer_spec_subclass"):
            spec=self._fresh_spec(); s=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
            class HSpec(Stage5FrozenRuleSpec):pass
            hspec=HSpec(schema_version=spec.schema_version,spec_payload=spec.spec_payload,
                param_payload=spec.param_payload,strategy_id=spec.strategy_id,version=spec.version,
                spec_id=spec.spec_id,parameter_id=spec.parameter_id,components=spec.components,
                symbols=spec.symbols,entry_rules=spec.entry_rules,exit_rules=spec.exit_rules,
                warmup_bars=spec.warmup_bars,frozen_id=spec.frozen_id)
            with self.assertRaisesRegex(ValueError,"PROD_SPEC_TYPE"):
                produce_observations(spec=hspec,snapshots=(s,),dataset_id=_DID,
                    symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)

    def test_subclass_producer_snapshots_rejected(self):
        class HT(tuple):pass
        spec=self._fresh_spec(); s=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        with self.subTest(route="tuple_subclass"):
            ss=HT((s,))
            with self.assertRaisesRegex(ValueError, "PROD_SNAPS_NOT_TUPLE"):
                produce_observations(spec=spec,snapshots=ss,dataset_id=_DID,
                    symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        with self.subTest(route="element_subclass"):
            class HS(Stage5ComponentSnapshot):pass
            hs=HS(schema_version=s.schema_version,strategy_id=s.strategy_id,
                spec_id=s.spec_id,parameter_id=s.parameter_id,dataset_id=s.dataset_id,
                symbol=s.symbol,bar_open_time_ms=s.bar_open_time_ms,
                has_outputs=s.has_outputs,components=s.components,snapshot_id=s.snapshot_id)
            with self.assertRaisesRegex(ValueError, "PROD_SNAP_TYPE_0"):
                produce_observations(spec=spec,snapshots=(hs,),dataset_id=_DID,
                    symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)

    def test_subclass_verifier_batch_rejected(self):
        spec=self._fresh_spec(); s=_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        b=produce_observations(spec=spec,snapshots=(s,),dataset_id=_DID,symbol=_SYM,
            scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        class HBatch(Stage5ObservationBatch):pass
        hb=HBatch(schema_version=b.schema_version,strategy_id=b.strategy_id,
            frozen_spec_id=b.frozen_spec_id,spec_id=b.spec_id,parameter_id=b.parameter_id,
            dataset_id=b.dataset_id,symbol=b.symbol,
            scored_start_open_time_ms=b.scored_start_open_time_ms,
            scored_end_exclusive_open_time_ms=b.scored_end_exclusive_open_time_ms,
            observations=b.observations,snapshot_ids=b.snapshot_ids,batch_id=b.batch_id)
        # batch subclass
        with self.subTest(route="batch_subclass"):
            with self.assertRaisesRegex(ValueError, "VERIFY_BATCH_TYPE"):
                verify_observation_batch(batch=hb,spec=spec,snapshots=(s,),dataset_id=_DID,
                    symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        # delegated routes — valid exact batch, subclassed context args
        class HSpec(Stage5FrozenRuleSpec):pass
        hspec=HSpec(schema_version=spec.schema_version,spec_payload=spec.spec_payload,
            param_payload=spec.param_payload,strategy_id=spec.strategy_id,version=spec.version,
            spec_id=spec.spec_id,parameter_id=spec.parameter_id,components=spec.components,
            symbols=spec.symbols,entry_rules=spec.entry_rules,exit_rules=spec.exit_rules,
            warmup_bars=spec.warmup_bars,frozen_id=spec.frozen_id)
        with self.subTest(route="spec_subclass"):
            with self.assertRaisesRegex(ValueError, "PROD_SPEC_TYPE"):
                verify_observation_batch(batch=b,spec=hspec,snapshots=(s,),dataset_id=_DID,
                    symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        class HT(tuple):pass
        with self.subTest(route="snapshots_tuple_subclass"):
            with self.assertRaisesRegex(ValueError, "PROD_SNAPS_NOT_TUPLE"):
                verify_observation_batch(batch=b,spec=spec,snapshots=HT((s,)),dataset_id=_DID,
                    symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        class HS(str):pass
        with self.subTest(route="dataset_subclass"):
            with self.assertRaisesRegex(ValueError, "PROD_DATASET_MALFORMED"):
                verify_observation_batch(batch=b,spec=spec,snapshots=(s,),dataset_id=HS(_DID),
                    symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        with self.subTest(route="symbol_subclass"):
            with self.assertRaisesRegex(ValueError, "PROD_SYMBOL_NOT_STRING"):
                verify_observation_batch(batch=b,spec=spec,snapshots=(s,),dataset_id=_DID,
                    symbol=HS(_SYM),scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        class HInt(int):pass
        with self.subTest(route="start_subclass"):
            with self.assertRaisesRegex(ValueError, "PROD_START_NOT_INT"):
                verify_observation_batch(batch=b,spec=spec,snapshots=(s,),dataset_id=_DID,
                    symbol=_SYM,scored_start_open_time_ms=HInt(0),scored_end_exclusive_open_time_ms=2*F)
        with self.subTest(route="end_subclass"):
            with self.assertRaisesRegex(ValueError, "PROD_END_NOT_INT"):
                verify_observation_batch(batch=b,spec=spec,snapshots=(s,),dataset_id=_DID,
                    symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=HInt(2*F))

    # --- 2C: deep caller immutability ---
    def test_deep_spec_immutability_on_success(self):
        import copy
        p=_trend_impulse_payload(); orig=copy.deepcopy(p)
        ps0={"tp":21,"tm":2.0,"max_holding_bars":96}; orig_ps=copy.deepcopy(ps0)
        spec=create_frozen_rule_spec(p,_spec_id(p),ps0)
        self.assertEqual(_thaw(spec.spec_payload),orig)
        self.assertEqual(ps0,orig_ps)
        p["strategyId"]="evil"; p["components"][0]["assetId"]="X"
        ps0["tp"]=999
        self.assertEqual(_thaw(spec.spec_payload),orig)
        self.assertEqual(_thaw(spec.param_payload),orig_ps)
        self.assertEqual(spec.strategy_id,_SID)

    def test_deep_spec_immutability_on_rejection(self):
        import copy
        p=_trend_impulse_payload(); orig=copy.deepcopy(p)
        ps={"tp":21,"tm":2.0,"max_holding_bars":96}; orig_ps=copy.deepcopy(ps)
        with self.assertRaisesRegex(ValueError,"FACTORY_SPEC_ID_MISMATCH"):
            create_frozen_rule_spec(p,"0"*64,ps)
        self.assertEqual(p,orig); self.assertEqual(ps,orig_ps)

    def test_deep_snapshot_immutability(self):
        import copy
        spec=self._fresh_spec()
        out={"TrendImpulse":{"signal":"BULL","name":"TI","nested":[1,2]}};orig=copy.deepcopy(out)
        s=_snap(spec,0,components=out); sid0=s.snapshot_id
        # --- success immutability ---
        self.assertEqual(_thaw(s.components),orig)
        out["TrendImpulse"]["signal"]="EVIL"; out["TrendImpulse"]["nested"][0]=999
        self.assertEqual(_thaw(s.components),orig)
        self.assertEqual(s.snapshot_id,sid0)
        # --- rejection immutability ---
        out2={"TrendImpulse":{"signal":"BULL"}}; orig2=copy.deepcopy(out2)
        class HSpec(Stage5FrozenRuleSpec):pass
        vs=HSpec(schema_version=spec.schema_version,spec_payload=spec.spec_payload,
            param_payload=spec.param_payload,strategy_id=spec.strategy_id,version=spec.version,
            spec_id=spec.spec_id,parameter_id=spec.parameter_id,components=spec.components,
            symbols=spec.symbols,entry_rules=spec.entry_rules,exit_rules=spec.exit_rules,
            warmup_bars=spec.warmup_bars,frozen_id=spec.frozen_id)
        with self.assertRaisesRegex(ValueError,"SNAP_FACTORY_SPEC_TYPE"):
            _snap(vs,0,components=out2)
        self.assertEqual(out2,orig2)

    def test_deep_producer_snapshots_immutability(self):
        import copy
        spec=self._fresh_spec(); orig_spec=copy.deepcopy(spec)
        out={"TrendImpulse":{"signal":"BULL"}}; orig_out=copy.deepcopy(out)
        s=_snap(spec,0,components=out); sid0=s.snapshot_id; ss=(s,); oss=copy.deepcopy(ss)
        # --- success immutability ---
        b=self._produce(spec,ss)
        self.assertEqual(spec,orig_spec); self.assertEqual(ss,oss)
        self.assertEqual(s.snapshot_id,sid0); self.assertEqual(out,orig_out)
        self.assertEqual(b.spec_id,spec.spec_id)
        # --- verifier success immutability ---
        b0=copy.deepcopy(b); s0=copy.deepcopy(s); spec0v=copy.deepcopy(spec); ss0v=copy.deepcopy((s,))
        verify_observation_batch(batch=b,spec=spec,snapshots=(s,),dataset_id=_DID,
            symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        self.assertEqual(b,b0); self.assertEqual(s,s0)
        self.assertEqual(spec,spec0v); self.assertEqual((s,),ss0v)
        # --- verifier rejection immutability ---
        with self.assertRaisesRegex(ValueError,"PROD_SNAP_DATASET_0"):
            verify_observation_batch(batch=b,spec=spec,snapshots=(s,),dataset_id="0"*64,
                symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        self.assertEqual(b,b0); self.assertEqual(s,s0); self.assertEqual(spec,spec0v)
        # --- producer rejection immutability ---
        spec2=self._fresh_spec(); s2=_snap(spec2,0,components=out); sid2=s2.snapshot_id
        ss2=(s2,); oss2=copy.deepcopy(ss2); spec20=copy.deepcopy(spec2)
        with self.assertRaisesRegex(ValueError,"PROD_SNAP_DATASET_0"):
            produce_observations(spec=spec2,snapshots=ss2,dataset_id="0"*64,
                symbol=_SYM,scored_start_open_time_ms=0,scored_end_exclusive_open_time_ms=2*F)
        self.assertEqual(spec2,spec20); self.assertEqual(ss2,oss2)
        self.assertEqual(s2.snapshot_id,sid2); self.assertEqual(out,orig_out)


if __name__=="__main__":
    unittest.main()
