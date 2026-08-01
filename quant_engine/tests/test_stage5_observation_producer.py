"""Stage 5.4-C observation producer — TDD test gates."""

import unittest

from quant_engine.proof.stage5_observation_producer import (
    Stage5FrozenRuleSpec, Stage5ComponentSnapshot, Stage5ObservationBatch,
    create_frozen_rule_spec, create_component_snapshot,
    produce_observations, verify_observation_batch,
)
from quant_engine.proof.stage5_intent_compiler import (
    Stage5StrategyIntentObservation,
)
from quant_engine.proof.stage5_evaluation import canonical_sha256

F = 300_000
_SID = "derived-test-strategy"
_SYM = "BTC/USDT"
_DID = "d" * 64


# --- REFERENCE FIXTURES (cannot be promoted to production) ---

def _trend_impulse_payload():
    return {
        "label":"NEW DERIVED STRATEGY SPEC","strategyId":_SID,"version":"1.0.0",
        "components":[{"assetId":"TrendImpulse","parameterMap":{"period":"tp","mult":"tm"}}],
        "entryRules":[
            {"side":"long","all":[{"component":"TrendImpulse","field":"signal","operator":"eq","value":"BULL"}]},
            {"side":"short","all":[{"component":"TrendImpulse","field":"signal","operator":"eq","value":"BEAR"}]},
        ],
        "exitRules":[
            {"position":"long","any":[{"component":"TrendImpulse","field":"signal","operator":"eq","value":"BEAR"}]},
            {"position":"short","any":[{"component":"TrendImpulse","field":"signal","operator":"eq","value":"BULL"}]},
        ],
        "positionLifecycle":{"flatEntry":"eval","reversal":"yes"},
        "riskRules":{"stopLoss":"ATR","takeProfit":"ATR*rr"},
        "timeframe":["5m"],"symbols":[_SYM],
        "parameters":{"selectionPolicy":"explicit-enumeration-only","candidateSets":[{"tp":21,"tm":2.0,"max_holding_bars":96}]},
        "warmupBars":30,"executionTiming":"closed-bar-next-open",
        "costModel":{"type":"bps"},"sourceAssetDigests":{"TrendImpulse":{"a":"b"*64}},
    }

def _spec_id(payload):
    return canonical_sha256({k:v for k,v in payload.items() if k!="specId"})

def _trend_spec():
    payload = _trend_impulse_payload()
    return create_frozen_rule_spec(payload, _spec_id(payload), {"tp":21,"tm":2.0,"max_holding_bars":96})

def _snap(spec, time, has_outputs=True, components=None):
    return create_component_snapshot(
        strategy_id=_SID, spec_id=spec.spec_id, parameter_id=spec.parameter_id,
        dataset_id=_DID, symbol=_SYM, bar_open_time_ms=time,
        has_outputs=has_outputs, component_outputs=components or {},
        component_ids=spec.components)


class RuleSpecTests(unittest.TestCase):
    def test_valid_spec_deterministic(self):
        a = _trend_spec()
        b = _trend_spec()
        self.assertEqual(a.frozen_id, b.frozen_id)

    def test_spec_id_mismatch_rejected(self):
        payload = _trend_impulse_payload()
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(payload, "x"*64, {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_parameter_not_in_candidate_rejected(self):
        payload = _trend_impulse_payload()
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(payload, _spec_id(payload), {"tp":99,"tm":9.0,"max_holding_bars":96})

    def test_unsupported_execution_rejected(self):
        payload = dict(_trend_impulse_payload())
        payload["executionTiming"] = "intrabar"
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(payload, _spec_id(payload), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_frozen_spec_immutable(self):
        spec = _trend_spec()
        sid0 = spec.frozen_id
        with self.assertRaises(Exception):
            spec.frozen_id = "X"
        self.assertEqual(spec.frozen_id, sid0)

    def test_entry_rules_enforce_side_long_short(self):
        payload = _trend_impulse_payload()
        payload["entryRules"] = [{"side":"flat","all":payload["entryRules"][0]["all"]}]
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(payload, _spec_id(payload), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_rule_empty_clauses_rejected(self):
        payload = _trend_impulse_payload()
        payload["entryRules"] = [{"side":"long","all":[]}]
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(payload, _spec_id(payload), {"tp":21,"tm":2.0,"max_holding_bars":96})

    def test_rule_unknown_operator_rejected(self):
        payload = _trend_impulse_payload()
        payload["entryRules"][0]["all"][0]["operator"] = "gt"
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(payload, _spec_id(payload), {"tp":21,"tm":2.0,"max_holding_bars":96})


class SnapshotTests(unittest.TestCase):
    def test_snapshot_deterministic(self):
        spec = _trend_spec()
        a = _snap(spec, 0, components={"TrendImpulse":{"name":"TrendImpulse","signal":"BULL"}})
        b = _snap(spec, 0, components={"TrendImpulse":{"name":"TrendImpulse","signal":"BULL"}})
        self.assertEqual(a.snapshot_id, b.snapshot_id)

    def test_snapshot_no_output_rejects_components(self):
        spec = _trend_spec()
        with self.assertRaises(ValueError):
            create_component_snapshot(strategy_id=_SID, spec_id=spec.spec_id,
                parameter_id=spec.parameter_id, dataset_id=_DID, symbol=_SYM,
                bar_open_time_ms=0, has_outputs=False,
                component_outputs={"TrendImpulse":{"signal":"BULL"}},
                component_ids=spec.components)

    def test_snapshot_has_output_rejects_empty(self):
        spec = _trend_spec()
        with self.assertRaises(ValueError):
            create_component_snapshot(strategy_id=_SID, spec_id=spec.spec_id,
                parameter_id=spec.parameter_id, dataset_id=_DID, symbol=_SYM,
                bar_open_time_ms=0, has_outputs=True,
                component_outputs={}, component_ids=spec.components)

    def test_snapshot_extra_component_rejected(self):
        spec = _trend_spec()
        with self.assertRaises(ValueError):
            create_component_snapshot(strategy_id=_SID, spec_id=spec.spec_id,
                parameter_id=spec.parameter_id, dataset_id=_DID, symbol=_SYM,
                bar_open_time_ms=0, has_outputs=True,
                component_outputs={"TrendImpulse":{"signal":"BULL"},"Extra":{"x":1}},
                component_ids=spec.components)

    def test_snapshot_id_tamper_rejected(self):
        spec = _trend_spec()
        s = _snap(spec, 0, components={"TrendImpulse":{"signal":"BULL"}})
        object.__setattr__(s, "snapshot_id", "x"*64)
        with self.assertRaises(ValueError):
            Stage5ComponentSnapshot.__post_init__(s)


class ProducerTests(unittest.TestCase):
    def _produce(self, spec, snapshots, scored_end=None):
        if scored_end is None: scored_end = F * (len(snapshots) + 1)
        return produce_observations(
            spec=spec, snapshots=snapshots, dataset_id=_DID, symbol=_SYM,
            scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=scored_end,
        )

    def test_single_bull_entry(self):
        spec = _trend_spec()
        snaps = (_snap(spec, 0, components={"TrendImpulse":{"signal":"BULL"}}),)
        batch = self._produce(spec, snaps)
        obs = batch.observations[0]
        self.assertTrue(obs.long_entry)
        self.assertFalse(obs.short_entry)

    def test_single_bear_entry(self):
        spec = _trend_spec()
        snaps = (_snap(spec, 0, components={"TrendImpulse":{"signal":"BEAR"}}),)
        batch = self._produce(spec, snaps)
        self.assertTrue(batch.observations[0].short_entry)

    def test_simultaneous_long_short_entry(self):
        spec = _trend_spec()
        snaps = (_snap(spec, 0, components={"TrendImpulse":{"signal":"BULL"}}),)
        batch = self._produce(spec, snaps)
        self.assertTrue(batch.observations[0].long_entry)
        self.assertFalse(batch.observations[0].short_entry)

    def test_all_false(self):
        spec = _trend_spec()
        snaps = (_snap(spec, 0, components={"TrendImpulse":{"signal":"HOLD"}}),)
        batch = self._produce(spec, snaps)
        o = batch.observations[0]
        self.assertFalse(o.long_entry and o.short_entry and o.long_exit and o.short_exit)

    def test_has_outputs_false_all_booleans_false(self):
        spec = _trend_spec()
        snaps = (_snap(spec, 0, has_outputs=False),)
        batch = self._produce(spec, snaps)
        o = batch.observations[0]
        self.assertFalse(o.long_entry or o.short_entry or o.long_exit or o.short_exit)

    def test_deterministic_batch_id(self):
        spec = _trend_spec()
        snaps = (_snap(spec, 0, components={"TrendImpulse":{"signal":"BULL"}}),)
        self.assertEqual(self._produce(spec,snaps).batch_id, self._produce(spec,snaps).batch_id)

    def test_verify_roundtrip(self):
        spec = _trend_spec()
        snaps = (_snap(spec, 0, components={"TrendImpulse":{"signal":"BULL"}}),)
        batch = self._produce(spec, snaps)
        got = verify_observation_batch(batch=batch, spec=spec, snapshots=snaps,
            dataset_id=_DID, symbol=_SYM, scored_start_open_time_ms=0,
            scored_end_exclusive_open_time_ms=F*(len(snaps)+1))
        self.assertIs(got, batch)

    def test_count_mismatch_rejected(self):
        spec = _trend_spec()
        with self.assertRaises(ValueError):
            self._produce(spec, (), scored_end=2*F)

    def test_time_gap_rejected(self):
        spec = _trend_spec()
        with self.assertRaises(ValueError):
            self._produce(spec, (_snap(spec,0), _snap(spec,2*F)))

    def test_lineage_mismatch_rejected(self):
        spec = _trend_spec()
        s = _snap(spec, 0, components={"TrendImpulse":{"signal":"BULL"}})
        object.__setattr__(s, "spec_id", "x"*64)
        with self.assertRaises(ValueError):
            self._produce(spec, (s,))

    def test_component_field_missing(self):
        spec = _trend_spec()
        snaps = (_snap(spec, 0, components={"TrendImpulse":{"name":"TrendImpulse"}}),)
        batch = self._produce(spec, snaps)
        self.assertFalse(batch.observations[0].long_entry)

    def test_extra_component_field_allowed(self):
        spec = _trend_spec()
        s1 = _snap(spec, 0, components={"TrendImpulse":{"signal":"BULL","name":"TI","extra":1}})
        s2 = _snap(spec, 0, components={"TrendImpulse":{"signal":"BULL","name":"TI"}})
        self.assertNotEqual(s1.snapshot_id, s2.snapshot_id)

    def test_one_bar_zero_snapshot(self):
        spec = _trend_spec()
        batch = produce_observations(spec=spec, snapshots=(), dataset_id=_DID, symbol=_SYM,
            scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F)
        self.assertEqual(len(batch.observations), 0)

    def test_final_bar_reserved(self):
        spec = _trend_spec()
        with self.assertRaises(ValueError):
            self._produce(spec, tuple(_snap(spec,i*F) for i in range(10)), scored_end=F*10)

    def test_forbidden_imports(self):
        import ast, os, importlib.util
        path = os.path.join(os.path.dirname(__file__), "..", "proof", "stage5_observation_producer.py")
        with open(path) as f:
            tree = ast.parse(f.read())
        imports = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.update(a.name for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.add(node.module)
        forbidden = {"strategy_spec","strategy_adapter","stage5_harness","stage5r1_replay",
                     "stage5r1_protective_replay","numpy","pandas","indicators"}
        for fbd in forbidden:
            self.assertFalse(any(fbd in i for i in imports), f"Forbidden: {fbd}")

    def test_hostile_spec_factory_plain_obj(self):
        class H:
            def __bool__(self): raise RuntimeError("X")
            __repr__=__str__=__hash__=__int__=__float__=__eq__=__ne__=__lt__=__le__=__gt__=__ge__=__bool__
        with self.assertRaises(ValueError):
            create_frozen_rule_spec(H(), "x"*64, {"tp":21})

    def test_snapshot_count_mismatch_too_many(self):
        spec = _trend_spec()
        with self.assertRaises(ValueError):
            self._produce(spec, tuple(_snap(spec,i*F,components={"TrendImpulse":{"signal":"BULL"}}) for i in range(10)), scored_end=F*10)

    def test_snapshot_time_not_aligned(self):
        spec = _trend_spec()
        with self.assertRaises(ValueError):
            create_component_snapshot(strategy_id=_SID, spec_id=spec.spec_id,
                parameter_id=spec.parameter_id, dataset_id=_DID, symbol=_SYM,
                bar_open_time_ms=150_000, has_outputs=False, component_outputs={},
                component_ids=spec.components)

    def test_batch_id_changes_with_snapshot_content(self):
        spec = _trend_spec()
        a = self._produce(spec, (_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}}),))
        b = self._produce(spec, (_snap(spec,0,components={"TrendImpulse":{"signal":"BEAR"}}),))
        self.assertNotEqual(a.batch_id, b.batch_id)

    def test_verify_rejects_mismatch(self):
        spec = _trend_spec()
        snaps = (_snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}}),)
        batch = self._produce(spec, snaps)
        with self.assertRaises(ValueError):
            verify_observation_batch(batch=batch, spec=spec, snapshots=snaps,
                dataset_id="x"*64, symbol=_SYM, scored_start_open_time_ms=0,
                scored_end_exclusive_open_time_ms=F*2)

    def test_caller_snapshot_unchanged(self):
        spec = _trend_spec()
        s = _snap(spec,0,components={"TrendImpulse":{"signal":"BULL"}})
        sid0 = s.snapshot_id
        self._produce(spec, (s,))
        self.assertEqual(s.snapshot_id, sid0)

    def test_transitive_no_forbidden(self):
        import ast, importlib.util, os
        forbidden = {"strategy_spec","strategy_adapter","stage5_harness","stage5r1_replay",
                     "stage5r1_protective_replay","numpy","pandas","indicators"}
        required = {"quant_engine.proof.stage5_observation_producer",
                    "quant_engine.proof.stage5_intent_compiler",
                    "quant_engine.proof.stage5_evaluation"}
        visited, parsed, queue = set(), set(), ["quant_engine.proof.stage5_observation_producer"]
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
                if isinstance(n, ast.Import):
                    for a in n.names:
                        if a.name.startswith("quant_engine"): queue.append(a.name)
                elif isinstance(n, ast.ImportFrom) and n.module and n.module.startswith("quant_engine"):
                    queue.append(n.module)
        for r in required: self.assertIn(r, parsed, f"Missing:{r}")
        found = {m for f in forbidden for m in visited if f in m}
        self.assertEqual(found, set(), f"Forbidden transitive:{found}")


if __name__ == "__main__":
    unittest.main()
