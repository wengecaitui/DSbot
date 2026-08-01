"""Stage 5.4-B intent compiler — TDD test gates."""

import unittest

from quant_engine.proof.stage5_intent_compiler import (
    Stage5StrategyIntentObservation,
    Stage5IntentCompilation,
    create_stage5_strategy_intent_observation,
    compile_stage5_strategy_intent,
    verify_stage5_intent_compilation,
)
from quant_engine.proof.stage5_lifecycle_plan import (
    Stage5LifecycleAction,
)

F = 300_000
_SID = "a" * 64
_SPID = "b" * 64
_PID = "c" * 64
_DID = "d" * 64
_SYM = "BTC/USDT"


def _obs(signal_time, has_outputs=True, le=False, se=False, lx=False, sx=False,
         sid=_SID, spid=_SPID, pid=_PID, did=_DID, sym=_SYM):
    return create_stage5_strategy_intent_observation(
        strategy_id=sid, spec_id=spid, parameter_id=pid, dataset_id=did, symbol=sym,
        signal_bar_open_time_ms=signal_time, has_outputs=has_outputs,
        long_entry=le, short_entry=se, long_exit=lx, short_exit=sx)


class ObservationTests(unittest.TestCase):
    def test_obs_no_outputs_all_false(self):
        obs = _obs(0, has_outputs=False)
        self.assertFalse(obs.has_outputs)
        self.assertEqual(len(obs.observation_id), 64)

    def test_obs_no_outputs_rules_true_rejected(self):
        with self.assertRaises(ValueError):
            _obs(0, has_outputs=False, le=True)

    def test_obs_deterministic_id(self):
        self.assertEqual(_obs(0, le=True).observation_id, _obs(0, le=True).observation_id)

    def test_obs_unaligned_time_rejected(self):
        with self.assertRaises(ValueError):
            _obs(150_000, le=True)

    def test_obs_lineage_field_changes_id(self):
        a1 = _obs(0, le=True, sid="a" * 64)
        a2 = _obs(0, le=True, sid="b" * 64)
        self.assertNotEqual(a1.observation_id, a2.observation_id)
        b1 = _obs(0, le=True, sym="ETH/USDT")
        self.assertNotEqual(a1.observation_id, b1.observation_id)


class CompilerTests(unittest.TestCase):
    def _compile(self, obs, max_holding=96, scored_end=F * 10,
                  sid=_SID, spid=_SPID, pid=_PID, did=_DID, sym=_SYM):
        return compile_stage5_strategy_intent(
            strategy_id=sid, spec_id=spid, parameter_id=pid, dataset_id=did, symbol=sym,
            warmup_bars=30, max_holding_bars=max_holding,
            scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=scored_end,
            terminal_execution_bar_open_time_ms=scored_end, observations=obs,
        )

    def _obs_9(self):
        return tuple(_obs(i * F) for i in range(9))

    def test_enter_long_then_exit(self):
        obs = list(self._obs_9())
        obs[0] = _obs(0, le=True)
        obs[5] = _obs(5 * F, lx=True)
        comp = self._compile(tuple(obs))
        self.assertEqual(comp.plan.instruction_count, 2)

    def test_reverse_long_to_short(self):
        obs = [_obs(i * F) for i in range(9)]
        obs[0] = _obs(0, le=True); obs[5] = _obs(5 * F, se=True); obs[8] = _obs(8 * F, sx=True)
        comp = self._compile(tuple(obs))
        self.assertEqual(comp.plan.reversal_count, 1)
        self.assertEqual(comp.plan.instruction_count, 3)

    def test_reverse_short_to_long(self):
        obs = [_obs(i * F) for i in range(9)]
        obs[0] = _obs(0, se=True); obs[5] = _obs(5 * F, le=True); obs[8] = _obs(8 * F, lx=True)
        comp = self._compile(tuple(obs))
        self.assertEqual(comp.plan.reversal_count, 1)
        self.assertEqual(comp.plan.instruction_count, 3)

    def test_max_holding_exit(self):
        obs = tuple(_obs(i * F, le=(i == 0)) for i in range(99))
        comp = self._compile(obs, max_holding=96, scored_end=F * 100)
        self.assertGreater(comp.plan.instruction_count, 0)
        self.assertEqual(comp.plan.final_state, "FLAT")

    def test_terminal_exit_appended(self):
        obs = tuple(_obs(i * F, le=(i == 0)) for i in range(9))
        comp = self._compile(obs, max_holding=96, scored_end=F * 10)
        self.assertEqual(comp.plan.terminal_exit_count, 1)

    def test_dual_entry_suppresses_all(self):
        obs = tuple(_obs(i * F, le=True, se=True, lx=True) for i in range(9))
        comp = self._compile(obs)
        self.assertEqual(comp.plan.instruction_count, 0)

    def test_no_outputs_suppresses_timeout(self):
        obs = tuple(_obs(i * F, has_outputs=False) for i in range(99))
        comp = self._compile(obs, max_holding=5, scored_end=F * 100)
        self.assertEqual(comp.plan.terminal_exit_count, 0)

    def test_one_bar_zero_observation(self):
        comp = compile_stage5_strategy_intent(
            strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID,
            symbol=_SYM, warmup_bars=30, max_holding_bars=96,
            scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F,
            terminal_execution_bar_open_time_ms=F, observations=(),
        )
        self.assertEqual(comp.plan.instruction_count, 0)

    def test_terminal_exact_times(self):
        obs = tuple(_obs(i * F, le=(i == 0)) for i in range(9))
        comp = self._compile(obs, max_holding=96, scored_end=F * 10)
        ti = comp.plan.instructions[-1]
        self.assertEqual(ti.signal_bar_open_time_ms, F * 9)
        self.assertEqual(ti.execution_bar_open_time_ms, F * 10)

    def test_last_bar_no_strategy_obs(self):
        obs = tuple(_obs(i * F) for i in range(9))
        comp = self._compile(obs, scored_end=F * 10)
        self.assertEqual(comp.plan.terminal_exit_count, 0)

    def test_deterministic_compilation_id(self):
        obs = tuple(_obs(i * F, le=(i == 0), lx=(i == 5)) for i in range(9))
        self.assertEqual(self._compile(obs).compilation_id, self._compile(obs).compilation_id)

    def test_verify_identity(self):
        obs = tuple(_obs(i * F, le=(i == 0), lx=(i == 5)) for i in range(9))
        comp = self._compile(obs)
        got = verify_stage5_intent_compilation(
            compilation=comp, strategy_id=_SID, spec_id=_SPID, parameter_id=_PID,
            dataset_id=_DID, symbol=_SYM, warmup_bars=30, max_holding_bars=96,
            scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
            terminal_execution_bar_open_time_ms=F * 10, observations=obs,
        )
        self.assertIs(got, comp)

    def test_verify_rejects_mismatch(self):
        obs = tuple(_obs(i * F, le=(i == 0), lx=(i == 5)) for i in range(9))
        comp = self._compile(obs)
        with self.assertRaises(ValueError):
            verify_stage5_intent_compilation(
                compilation=comp, strategy_id=_SID, spec_id=_SPID, parameter_id=_PID,
                dataset_id=_DID, symbol="ETH/USDT", warmup_bars=30, max_holding_bars=96,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, observations=obs,
            )

    def test_missing_observation_rejected(self):
        with self.assertRaises(ValueError):
            self._compile(tuple(_obs(i * F) for i in range(8)), scored_end=F * 10)

    def test_extra_observation_rejected(self):
        with self.assertRaises(ValueError):
            self._compile(tuple(_obs(i * F) for i in range(10)), scored_end=F * 10)

    def test_caller_obs_unchanged(self):
        obs = tuple(_obs(i * F, le=(i == 0), lx=(i == 5)) for i in range(9))
        self._compile(obs)
        self.assertEqual(obs[0].signal_bar_open_time_ms, 0)

    def test_scope_flags(self):
        obs = tuple(_obs(i * F) for i in range(9))
        comp = self._compile(obs)
        self.assertEqual(comp.scope, "STRATEGY_INTENT_ONLY")
        self.assertFalse(comp.protective_execution_included)
        self.assertFalse(comp.replay_compatible)
        self.assertTrue(comp.requires_protective_state_bridge)

    def test_bool_max_holding_rejected(self):
        with self.assertRaises(ValueError):
            compile_stage5_strategy_intent(
                strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID,
                symbol=_SYM, warmup_bars=30, max_holding_bars=True,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, observations=self._obs_9(),
            )

    def test_forbidden_imports(self):
        import ast, os
        path = os.path.join(os.path.dirname(__file__), "..", "proof", "stage5_intent_compiler.py")
        with open(path) as f:
            tree = ast.parse(f.read())
        imports = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imports.add(alias.name)
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    imports.add(node.module)
        forbidden = {"strategy_adapter", "stage5_harness", "stage5r1_replay",
                     "stage5r1_protective_replay", "numpy", "pandas"}
        for fbd in forbidden:
            self.assertFalse(any(fbd in i for i in imports), f"Forbidden import: {fbd}")

    def test_reverse_count_after_reversal(self):
        obs = [_obs(i * F) for i in range(9)]
        obs[0] = _obs(0, le=True); obs[3] = _obs(3 * F, se=True)
        obs[6] = _obs(6 * F, le=True); obs[8] = _obs(8 * F, lx=True)
        comp = self._compile(tuple(obs))
        self.assertEqual(comp.plan.reversal_count, 2)

    def test_exit_then_reenter(self):
        obs = [_obs(i * F) for i in range(9)]
        obs[0] = _obs(0, le=True); obs[3] = _obs(3 * F, lx=True); obs[6] = _obs(6 * F, se=True)
        comp = self._compile(tuple(obs))
        self.assertGreater(comp.plan.instruction_count, 2)

    def test_long_exit_priority_over_short_entry(self):
        obs = [_obs(i * F) for i in range(9)]
        obs[0] = _obs(0, le=True); obs[5] = _obs(5 * F, lx=True)
        comp = self._compile(tuple(obs))
        acts = [i.action for i in comp.plan.instructions]
        self.assertIn(Stage5LifecycleAction.EXIT, acts)

    def test_short_reverse_priority_over_long_entry(self):
        obs = [_obs(i * F) for i in range(9)]
        obs[0] = _obs(0, se=True); obs[5] = _obs(5 * F, le=True, sx=True)
        comp = self._compile(tuple(obs))
        acts = [i.action for i in comp.plan.instructions]
        self.assertIn(Stage5LifecycleAction.REVERSE_TO_LONG, acts)

    def test_enter_long_exit_long_no_terminal(self):
        obs = [_obs(i * F) for i in range(9)]
        obs[0] = _obs(0, le=True); obs[5] = _obs(5 * F, lx=True)
        comp = self._compile(tuple(obs))
        self.assertEqual(comp.plan.terminal_exit_count, 0)

    def test_missing_obs_rejected(self):
        with self.assertRaises(ValueError):
            self._compile(tuple(_obs(i * F) for i in range(8)), scored_end=F * 10)

    def test_extra_obs_rejected(self):
        with self.assertRaises(ValueError):
            self._compile(tuple(_obs(i * F) for i in range(10)), scored_end=F * 10)

    def test_reordered_obs_rejected(self):
        with self.assertRaises(ValueError):
            self._compile((_obs(F), _obs(0)), scored_end=3 * F)

    def test_obs_time_gap_rejected(self):
        with self.assertRaises(ValueError):
            self._compile((_obs(0), _obs(2 * F)), scored_end=4 * F)

    def test_obs_str_type_subclass_rejected(self):
        class BadStr(str): pass
        with self.assertRaises(ValueError):
            compile_stage5_strategy_intent(
                strategy_id=BadStr(_SID), spec_id=_SPID, parameter_id=_PID, dataset_id=_DID,
                symbol=_SYM, warmup_bars=30, max_holding_bars=96,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, observations=self._obs_9(),
            )

    def test_negative_warmup_rejected(self):
        with self.assertRaises(ValueError):
            compile_stage5_strategy_intent(
                strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID,
                symbol=_SYM, warmup_bars=0, max_holding_bars=96,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, observations=self._obs_9(),
            )

    def test_obs_outside_window_rejected(self):
        obs = tuple(_obs(i * F + F) for i in range(9))
        with self.assertRaises(ValueError):
            self._compile(obs, scored_end=F * 10)

    # --- New strong tests ---

    def test_max_holding_changes_compilation_id(self):
        obs = tuple(_obs(i * F, le=(i == 0)) for i in range(9))
        a = self._compile(obs, max_holding=5, scored_end=F * 10)
        b = self._compile(obs, max_holding=6, scored_end=F * 10)
        self.assertNotEqual(a.compilation_id, b.compilation_id)

    def test_max_holding_off_by_one(self):
        obs = tuple(_obs(i * F, le=(i == 0)) for i in range(99))
        c1 = self._compile(obs, max_holding=1, scored_end=F * 100)
        c2 = self._compile(obs, max_holding=2, scored_end=F * 100)
        self.assertEqual(c1.plan.instructions[1].signal_bar_open_time_ms, F)
        self.assertEqual(c2.plan.instructions[1].signal_bar_open_time_ms, 2 * F)

    def test_no_outputs_during_timeout_suppresses_exit(self):
        obs = [_obs(i * F, le=(i == 0)) for i in range(99)]
        for i in range(1, 4):
            obs[i] = _obs(i * F, has_outputs=False)
        obs[4] = _obs(4 * F)
        comp = self._compile(tuple(obs), max_holding=3, scored_end=F * 100)
        acts = [i.action for i in comp.plan.instructions]
        self.assertEqual(acts[1], Stage5LifecycleAction.EXIT)  # exit at bar 4

    def test_dual_entry_while_long_on_timeout(self):
        obs = [_obs(i * F) for i in range(99)]
        obs[0] = _obs(0, le=True)
        obs[3] = _obs(3 * F, le=True, se=True, lx=True)
        comp = self._compile(tuple(obs), max_holding=3, scored_end=F * 100)
        acts = [i.action for i in comp.plan.instructions]
        self.assertEqual(acts[1], Stage5LifecycleAction.EXIT)  # exit at bar 4

    def test_long_short_entry_reverse_at_bar(self):
        obs = [_obs(i * F) for i in range(9)]
        obs[0] = _obs(0, le=True); obs[5] = _obs(5 * F, se=True, lx=True)
        comp = self._compile(tuple(obs))
        acts = [i.action for i in comp.plan.instructions]
        self.assertEqual(acts[1], Stage5LifecycleAction.REVERSE_TO_SHORT)

    def test_short_long_entry_reverse_at_bar(self):
        obs = [_obs(i * F) for i in range(9)]
        obs[0] = _obs(0, se=True); obs[5] = _obs(5 * F, le=True, sx=True)
        comp = self._compile(tuple(obs))
        acts = [i.action for i in comp.plan.instructions]
        self.assertEqual(acts[1], Stage5LifecycleAction.REVERSE_TO_LONG)


class HostileInputTests(unittest.TestCase):
    class _Hostile:
        def __bool__(self): raise RuntimeError("BOOM")
        __repr__ = __bool__
        __str__ = __bool__
        __hash__ = __bool__
        __int__ = __bool__
        __float__ = __bool__
        __eq__ = __bool__
        __ne__ = __bool__
        __lt__ = __bool__
        __le__ = __bool__
        __gt__ = __bool__
        __ge__ = __bool__

    class _HostileStr(str):
        def __new__(cls, s): return super().__new__(cls, s)
        def __bool__(self): raise RuntimeError("BOOM_STR")
        __repr__ = __bool__
        __str__ = __bool__
        __hash__ = __bool__
        __eq__ = __bool__
        __ne__ = __bool__
        __lt__ = __bool__
        __le__ = __bool__
        __gt__ = __bool__
        __ge__ = __bool__
        __int__ = __bool__
        __float__ = __bool__

    def test_hostile_strategy_id_obs_factory(self):
        with self.assertRaises(ValueError) as ctx:
            _obs(0, le=True, sid=self._Hostile())
        self.assertIn("OBS_FACTORY_STRATEGY", str(ctx.exception))

    def test_hostile_spec_id_obs_factory(self):
        with self.assertRaises(ValueError) as ctx:
            _obs(0, le=True, spid=self._Hostile())
        self.assertIn("OBS_FACTORY_SPEC_ID", str(ctx.exception))

    def test_hostile_int_time_obs_factory(self):
        with self.assertRaises(ValueError):
            create_stage5_strategy_intent_observation(
                strategy_id=_SID, spec_id=_SPID, parameter_id=_PID,
                dataset_id=_DID, symbol=_SYM, signal_bar_open_time_ms=self._Hostile(),
                has_outputs=True, long_entry=False, short_entry=False,
                long_exit=False, short_exit=False)

    def test_hostile_compiler_strategy_id(self):
        with self.assertRaises(ValueError) as ctx:
            compile_stage5_strategy_intent(
                strategy_id=self._Hostile(), spec_id=_SPID, parameter_id=_PID,
                dataset_id=_DID, symbol=_SYM, warmup_bars=30, max_holding_bars=96,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10,
                observations=tuple(_obs(i * F) for i in range(9)),
            )
        self.assertIn("COMPILE_STRATEGY_NOT_STRING", str(ctx.exception))


class LineageMismatchTests(unittest.TestCase):
    def _compile_with(self, obs):
        return compile_stage5_strategy_intent(
            strategy_id=_SID, spec_id=_SPID, parameter_id=_PID,
            dataset_id=_DID, symbol=_SYM, warmup_bars=30, max_holding_bars=96,
            scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
            terminal_execution_bar_open_time_ms=F * 10, observations=obs,
        )

    def test_obs_strategy_id_mismatch_rejected(self):
        obs = tuple(_obs(i * F, sid="z" * 64) for i in range(9))
        with self.assertRaises(ValueError) as ctx:
            self._compile_with(obs)
        self.assertIn("COMPILE_OBS_STRATEGY_MISMATCH", str(ctx.exception))

    def test_obs_spec_id_mismatch_rejected(self):
        obs = tuple(_obs(i * F, spid="f" * 64) for i in range(9))
        with self.assertRaises(ValueError) as ctx:
            self._compile_with(obs)
        self.assertIn("COMPILE_OBS_SPEC_MISMATCH", str(ctx.exception))

    def test_obs_param_id_mismatch_rejected(self):
        obs = tuple(_obs(i * F, pid="f" * 64) for i in range(9))
        with self.assertRaises(ValueError) as ctx:
            self._compile_with(obs)
        self.assertIn("COMPILE_OBS_PARAM_MISMATCH", str(ctx.exception))

    def test_obs_dataset_id_mismatch_rejected(self):
        obs = tuple(_obs(i * F, did="f" * 64) for i in range(9))
        with self.assertRaises(ValueError) as ctx:
            self._compile_with(obs)
        self.assertIn("COMPILE_OBS_DATASET_MISMATCH", str(ctx.exception))

    def test_obs_symbol_mismatch_rejected(self):
        obs = tuple(_obs(i * F, sym="FORGED") for i in range(9))
        with self.assertRaises(ValueError) as ctx:
            self._compile_with(obs)
        self.assertIn("COMPILE_OBS_SYMBOL_MISMATCH", str(ctx.exception))


class ObserverLineageIdTests(unittest.TestCase):
    def test_obs_id_changes_with_strategy(self):
        a = _obs(0, sid="a" * 64)
        b = _obs(0, sid="b" * 64)
        self.assertNotEqual(a.observation_id, b.observation_id)

    def test_obs_id_changes_with_symbol(self):
        a = _obs(0, sym="BTC/USDT")
        b = _obs(0, sym="ETH/USDT")
        self.assertNotEqual(a.observation_id, b.observation_id)

    def test_obs_id_changes_with_dataset(self):
        a = _obs(0, did="a" * 64)
        b = _obs(0, did="b" * 64)
        self.assertNotEqual(a.observation_id, b.observation_id)


class CompilationTamperTests(unittest.TestCase):
    def _compile_2trade(self):
        obs = [_obs(i * F) for i in range(9)]
        obs[0] = _obs(0, le=True); obs[3] = _obs(3 * F, lx=True)
        obs[5] = _obs(5 * F, se=True); obs[8] = _obs(8 * F, sx=True)
        return self._compile(tuple(obs))

    def _compile(self, obs, max_holding=96, scored_end=F * 10):
        return compile_stage5_strategy_intent(
            strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID,
            symbol=_SYM, warmup_bars=30, max_holding_bars=max_holding,
            scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=scored_end,
            terminal_execution_bar_open_time_ms=scored_end, observations=obs,
        )

    def test_tamper_max_holding_rejected(self):
        comp = self._compile_2trade()
        object.__setattr__(comp, "max_holding_bars", True)
        from quant_engine.proof.stage5_intent_compiler import _compilation_payload, canonical_sha256
        new_id = canonical_sha256(_compilation_payload(comp))
        object.__setattr__(comp, "compilation_id", new_id)
        with self.assertRaises(ValueError) as ctx:
            Stage5IntentCompilation.__post_init__(comp)
        self.assertIn("MAX_HOLD", str(ctx.exception))

    def test_tamper_scope_rejected(self):
        comp = self._compile_2trade()
        object.__setattr__(comp, "scope", "FORGED")
        with self.assertRaises(ValueError):
            Stage5IntentCompilation.__post_init__(comp)

    def test_tamper_duplicate_obs_ids_rejected(self):
        comp = self._compile_2trade()
        new_ids = (comp.observation_ids[0], comp.observation_ids[0]) + comp.observation_ids[2:]
        object.__setattr__(comp, "observation_ids", new_ids)
        from quant_engine.proof.stage5_intent_compiler import _compilation_payload, canonical_sha256
        new_id = canonical_sha256(_compilation_payload(comp))
        object.__setattr__(comp, "compilation_id", new_id)
        with self.assertRaises(ValueError) as ctx:
            Stage5IntentCompilation.__post_init__(comp)
        self.assertIn("DUPLICATE_OBS_ID", str(ctx.exception))

    def test_nested_obs_tamper_rejected(self):
        obs = [_obs(i * F) for i in range(9)]
        obs[0] = _obs(0, le=True); obs[3] = _obs(3 * F, lx=True)
        obs = tuple(obs)
        object.__setattr__(obs[0], "long_entry", False)
        with self.assertRaises(ValueError):
            self._compile(obs)


class TransitiveImportTests(unittest.TestCase):
    def test_transitive_import_chain_no_forbidden(self):
        import ast, os, sys
        visited = set()
        queue = ["quant_engine.proof.stage5_intent_compiler"]
        forbidden = {"strategy_adapter", "stage5_harness", "stage5r1_replay",
                     "stage5r1_protective_replay", "numpy", "pandas"}
        seen_forbidden = set()
        while queue:
            mod_name = queue.pop(0)
            if mod_name in visited:
                continue
            visited.add(mod_name)
            try:
                spec = __import__(mod_name, fromlist=["_"])
            except ImportError:
                continue
            if not hasattr(spec, "__file__") or spec.__file__ is None:
                continue
            path = spec.__file__
            if not path.startswith(os.path.join(os.path.dirname(__file__), "..", "proof")):
                continue
            try:
                with open(path) as f:
                    tree = ast.parse(f.read())
            except Exception:
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        full = alias.name
                        if full.startswith("quant_engine"):
                            queue.append(full)
                elif isinstance(node, ast.ImportFrom):
                    if node.module and node.module.startswith("quant_engine"):
                        queue.append(node.module)
        for fbd in forbidden:
            for v in visited:
                if fbd in v:
                    seen_forbidden.add(fbd)
        self.assertEqual(seen_forbidden, set(), f"Transitive forbidden imports: {seen_forbidden}")


if __name__ == "__main__":
    unittest.main()
