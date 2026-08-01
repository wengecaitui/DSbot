"""Stage 5.4-B intent compiler — TDD test gates."""

import unittest

from quant_engine.proof.stage5_intent_compiler import (
    Stage5StrategyIntentObservation,
    Stage5IntentCompilation,
    create_stage5_strategy_intent_observation,
    compile_stage5_strategy_intent,
    verify_stage5_intent_compilation,
    COMPILATION_SCOPE,
)
from quant_engine.proof.stage5_lifecycle_plan import (
    Stage5LifecycleAction,
)
from quant_engine.proof.stage5_evaluation import canonical_sha256

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
        base = _obs(0, le=True).observation_id
        for label, kw in [
            ("strategy_id", {"sid": "z" * 64}),
            ("spec_id", {"spid": "e" * 64}),
            ("parameter_id", {"pid": "f" * 64}),
            ("dataset_id", {"did": "0" * 64}),
            ("symbol", {"sym": "ETH/USDT"}),
        ]:
            with self.subTest(field=label):
                other = _obs(0, le=True, **kw)
                self.assertNotEqual(base, other.observation_id, f"ID unchanged for {label}")


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

    # --- Strengthened tests ---

    def test_max_holding_changes_compilation_id(self):
        obs = tuple(_obs(i * F, le=(i == 0), lx=(i == 3)) for i in range(9))
        a = self._compile(obs, max_holding=5, scored_end=F * 10)
        b = self._compile(obs, max_holding=6, scored_end=F * 10)
        self.assertEqual(a.plan.plan_id, b.plan.plan_id)
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
        times = [i.signal_bar_open_time_ms for i in comp.plan.instructions]
        self.assertEqual(acts[1], Stage5LifecycleAction.EXIT)
        self.assertEqual(times[1], 4 * F)
        self.assertNotIn(Stage5LifecycleAction.EXIT, acts[:1])

    def test_dual_entry_while_long_on_timeout(self):
        obs = [_obs(i * F) for i in range(99)]
        obs[0] = _obs(0, le=True)
        obs[3] = _obs(3 * F, le=True, se=True, lx=True)
        comp = self._compile(tuple(obs), max_holding=3, scored_end=F * 100)
        acts = [i.action for i in comp.plan.instructions]
        times = [i.signal_bar_open_time_ms for i in comp.plan.instructions]
        self.assertEqual(acts[1], Stage5LifecycleAction.EXIT)
        self.assertEqual(times[1], 4 * F)
        self.assertNotIn(Stage5LifecycleAction.EXIT, [acts[0]])

    def test_long_short_entry_reverse_at_bar(self):
        obs = [_obs(i * F) for i in range(9)]
        obs[0] = _obs(0, le=True); obs[5] = _obs(5 * F, se=True, lx=True)
        comp = self._compile(tuple(obs))
        acts = [i.action for i in comp.plan.instructions]
        times = [i.signal_bar_open_time_ms for i in comp.plan.instructions]
        self.assertEqual(acts[1], Stage5LifecycleAction.REVERSE_TO_SHORT)
        self.assertEqual(times[1], 5 * F)

    def test_short_long_entry_reverse_at_bar(self):
        obs = [_obs(i * F) for i in range(9)]
        obs[0] = _obs(0, se=True); obs[5] = _obs(5 * F, le=True, sx=True)
        comp = self._compile(tuple(obs))
        acts = [i.action for i in comp.plan.instructions]
        times = [i.signal_bar_open_time_ms for i in comp.plan.instructions]
        self.assertEqual(acts[1], Stage5LifecycleAction.REVERSE_TO_LONG)
        self.assertEqual(times[1], 5 * F)


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

    # --- Obs factory plain hostile: all fields table-driven ---
    def test_hostile_obs_factory_plain_all_fields(self):
        H = self._Hostile
        for field, call_fn, token in [
            ("strategy", lambda: create_stage5_strategy_intent_observation(
                strategy_id=H(), spec_id=_SPID, parameter_id=_PID, dataset_id=_DID, symbol=_SYM,
                signal_bar_open_time_ms=0, has_outputs=False,
                long_entry=False, short_entry=False, long_exit=False, short_exit=False),
             "OBS_FACTORY_STRATEGY"),
            ("spec", lambda: create_stage5_strategy_intent_observation(
                strategy_id=_SID, spec_id=H(), parameter_id=_PID, dataset_id=_DID, symbol=_SYM,
                signal_bar_open_time_ms=0, has_outputs=False,
                long_entry=False, short_entry=False, long_exit=False, short_exit=False),
             "OBS_FACTORY_SPEC_ID"),
            ("parameter", lambda: create_stage5_strategy_intent_observation(
                strategy_id=_SID, spec_id=_SPID, parameter_id=H(), dataset_id=_DID, symbol=_SYM,
                signal_bar_open_time_ms=0, has_outputs=False,
                long_entry=False, short_entry=False, long_exit=False, short_exit=False),
             "OBS_FACTORY_PARAM_ID"),
            ("dataset", lambda: create_stage5_strategy_intent_observation(
                strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=H(), symbol=_SYM,
                signal_bar_open_time_ms=0, has_outputs=False,
                long_entry=False, short_entry=False, long_exit=False, short_exit=False),
             "OBS_FACTORY_DATASET_ID"),
            ("symbol", lambda: create_stage5_strategy_intent_observation(
                strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID, symbol=H(),
                signal_bar_open_time_ms=0, has_outputs=False,
                long_entry=False, short_entry=False, long_exit=False, short_exit=False),
             "OBS_FACTORY_SYMBOL_NOT_STRING"),
            ("signal_time", lambda: create_stage5_strategy_intent_observation(
                strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID, symbol=_SYM,
                signal_bar_open_time_ms=H(), has_outputs=False,
                long_entry=False, short_entry=False, long_exit=False, short_exit=False),
             "OBS_FACTORY_TIME"),
            ("has_outputs", lambda: create_stage5_strategy_intent_observation(
                strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID, symbol=_SYM,
                signal_bar_open_time_ms=0, has_outputs=H(),
                long_entry=False, short_entry=False, long_exit=False, short_exit=False),
             "OBS_FACTORY_HAS"),
            ("long_entry", lambda: create_stage5_strategy_intent_observation(
                strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID, symbol=_SYM,
                signal_bar_open_time_ms=0, has_outputs=False,
                long_entry=H(), short_entry=False, long_exit=False, short_exit=False),
             "OBS_FACTORY_LE"),
            ("short_entry", lambda: create_stage5_strategy_intent_observation(
                strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID, symbol=_SYM,
                signal_bar_open_time_ms=0, has_outputs=False,
                long_entry=False, short_entry=H(), long_exit=False, short_exit=False),
             "OBS_FACTORY_SE"),
            ("long_exit", lambda: create_stage5_strategy_intent_observation(
                strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID, symbol=_SYM,
                signal_bar_open_time_ms=0, has_outputs=False,
                long_entry=False, short_entry=False, long_exit=H(), short_exit=False),
             "OBS_FACTORY_LX"),
            ("short_exit", lambda: create_stage5_strategy_intent_observation(
                strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID, symbol=_SYM,
                signal_bar_open_time_ms=0, has_outputs=False,
                long_entry=False, short_entry=False, long_exit=False, short_exit=H()),
             "OBS_FACTORY_SX"),
        ]:
            with self.subTest(field=field):
                with self.assertRaises(ValueError) as ctx:
                    call_fn()
                self.assertIn(token, str(ctx.exception),
                              f"Expected {token} for {field}, got: {ctx.exception}")

    # --- Obs factory hostile-str all 5 lineage fields ---
    def test_hostile_obs_factory_str_all_fields(self):
        for field, kw, token in [
            ("strategy", {"sid": self._HostileStr("x" * 64)}, "OBS_FACTORY_STRATEGY"),
            ("spec", {"spid": self._HostileStr("f" * 64)}, "OBS_FACTORY_SPEC_ID"),
            ("parameter", {"pid": self._HostileStr("f" * 64)}, "OBS_FACTORY_PARAM_ID"),
            ("dataset", {"did": self._HostileStr("f" * 64)}, "OBS_FACTORY_DATASET_ID"),
            ("symbol", {"sym": self._HostileStr("BTC/USDT")}, "OBS_FACTORY_SYMBOL_NOT_STRING"),
        ]:
            with self.subTest(field=field):
                with self.assertRaises(ValueError) as ctx:
                    _obs(0, **kw)
                self.assertIn(token, str(ctx.exception))

    # --- Compiler plain hostile: all fields table-driven ---
    def test_hostile_compiler_plain_all_fields(self):
        base = dict(strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID,
                     symbol=_SYM, warmup_bars=30, max_holding_bars=96,
                     scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                     terminal_execution_bar_open_time_ms=F * 10,
                     observations=tuple(_obs(i * F) for i in range(9)))
        for field, token in [
            ("strategy_id", "COMPILE_STRATEGY_NOT_STRING"),
            ("spec_id", "COMPILE_SPEC_ID"),
            ("parameter_id", "COMPILE_PARAM_ID"),
            ("dataset_id", "COMPILE_DATASET_ID"),
            ("symbol", "COMPILE_SYMBOL_NOT_STRING"),
            ("warmup_bars", "COMPILE_WARMUP_NOT_INT"),
            ("max_holding_bars", "COMPILE_MAX_HOLD_NOT_INT"),
            ("scored_start_open_time_ms", "COMPILE_START_NOT_INT"),
            ("scored_end_exclusive_open_time_ms", "COMPILE_END_NOT_INT"),
            ("terminal_execution_bar_open_time_ms", "COMPILE_TERMINAL_NOT_INT"),
            ("observations", "COMPILE_OBS_NOT_TUPLE"),
        ]:
            with self.subTest(field=field):
                with self.assertRaises(ValueError) as ctx:
                    compile_stage5_strategy_intent(**{**base, field: self._Hostile()})
                self.assertIn(token, str(ctx.exception))

    # --- Compiler hostile-str: all 5 lineage fields ---
    def test_hostile_compiler_str_all_fields(self):
        obs = tuple(_obs(i * F) for i in range(9))
        for field, value, token in [
            ("strategy_id", HostileInputTests._HostileStr("x" * 64), "COMPILE_STRATEGY_NOT_STRING"),
            ("spec_id", HostileInputTests._HostileStr("f" * 64), "COMPILE_SPEC_ID"),
            ("parameter_id", HostileInputTests._HostileStr("f" * 64), "COMPILE_PARAM_ID"),
            ("dataset_id", HostileInputTests._HostileStr("f" * 64), "COMPILE_DATASET_ID"),
            ("symbol", HostileInputTests._HostileStr("BTC/USDT"), "COMPILE_SYMBOL_NOT_STRING"),
        ]:
            with self.subTest(field=field):
                with self.assertRaises(ValueError) as ctx:
                    compile_stage5_strategy_intent(
                        strategy_id=_SID if field != "strategy_id" else value,
                        spec_id=_SPID if field != "spec_id" else value,
                        parameter_id=_PID if field != "parameter_id" else value,
                        dataset_id=_DID if field != "dataset_id" else value,
                        symbol=_SYM if field != "symbol" else value,
                        warmup_bars=30, max_holding_bars=96,
                        scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                        terminal_execution_bar_open_time_ms=F * 10, observations=obs,
                    )
                self.assertIn(token, str(ctx.exception))

    def test_compiler_direct_hostile_obs_ids_from_valid(self):
        # from valid compilation, mutate obs_ids to hostile tuple
        obs = tuple(_obs(i * F, le=(i == 0), lx=(i == 5)) for i in range(9))
        comp = compile_stage5_strategy_intent(
            strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID,
            symbol=_SYM, warmup_bars=30, max_holding_bars=96,
            scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
            terminal_execution_bar_open_time_ms=F * 10, observations=obs,
        )
        object.__setattr__(comp, "observation_ids", (self._Hostile(),))
        with self.assertRaises(ValueError) as ctx:
            Stage5IntentCompilation.__post_init__(comp)
        self.assertIn("COMPILATION_OBS_ID_MALFORMED", str(ctx.exception))

    # --- Direct observation hostile schema ---
    def test_obs_direct_hostile_schema(self):
        with self.assertRaises(ValueError) as ctx:
            Stage5StrategyIntentObservation(
                schema_version=self._Hostile(),
                strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID,
                symbol=_SYM, signal_bar_open_time_ms=0,
                has_outputs=True, long_entry=False, short_entry=False,
                long_exit=False, short_exit=False, observation_id="0" * 64,
            )
        self.assertIn("OBS_SCHEMA", str(ctx.exception))

    # --- Direct compilation hostile schema/scope ---
    def test_compilation_direct_hostile_schema(self):
        base = dict(schema_version=self._Hostile(), scope=COMPILATION_SCOPE, plan=None,
                     observation_ids=(), max_holding_bars=96,
                     protective_execution_included=False, replay_compatible=False,
                     requires_protective_state_bridge=True, compilation_id="0" * 64)
        with self.assertRaises(ValueError) as ctx:
            Stage5IntentCompilation(**base)
        self.assertIn("COMPILATION_SCHEMA", str(ctx.exception))

    def test_compilation_direct_hostile_scope(self):
        obs = tuple(_obs(i * F, le=(i == 0), lx=(i == 5)) for i in range(9))
        comp = compile_stage5_strategy_intent(
            strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID,
            symbol=_SYM, warmup_bars=30, max_holding_bars=96,
            scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
            terminal_execution_bar_open_time_ms=F * 10, observations=obs,
        )
        object.__setattr__(comp, "scope", self._Hostile())
        with self.assertRaises(ValueError) as ctx:
            Stage5IntentCompilation.__post_init__(comp)
        self.assertIn("COMPILATION_SCOPE", str(ctx.exception))


class DirectCompilationTamperTests(unittest.TestCase):
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

    def _valid_comp(self):
        obs = tuple(_obs(i * F, le=(i == 0), lx=(i == 5)) for i in range(9))
        return compile_stage5_strategy_intent(
            strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID,
            symbol=_SYM, warmup_bars=30, max_holding_bars=96,
            scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
            terminal_execution_bar_open_time_ms=F * 10, observations=obs,
        )

    def _recompute_id(self, comp):
        from quant_engine.proof.stage5_intent_compiler import _compilation_payload
        object.__setattr__(comp, "compilation_id", canonical_sha256(_compilation_payload(comp)))

    def test_hostile_obs_id_element(self):
        comp = self._valid_comp()
        object.__setattr__(comp, "observation_ids", (self._Hostile(),))
        with self.assertRaises(ValueError) as ctx:
            Stage5IntentCompilation.__post_init__(comp)
        self.assertIn("COMPILATION_OBS_ID_MALFORMED", str(ctx.exception))

    def test_malformed_obs_id_string(self):
        comp = self._valid_comp()
        object.__setattr__(comp, "observation_ids", ("not-a-sha",))
        with self.assertRaises(ValueError) as ctx:
            Stage5IntentCompilation.__post_init__(comp)
        self.assertIn("COMPILATION_OBS_ID_MALFORMED", str(ctx.exception))

    def test_non_tuple_obs_ids(self):
        comp = self._valid_comp()
        object.__setattr__(comp, "observation_ids", ["abc123"] * 9)
        with self.assertRaises(ValueError) as ctx:
            Stage5IntentCompilation.__post_init__(comp)
        self.assertIn("COMPILATION_OBS_IDS_NOT_TUPLE", str(ctx.exception))

    def test_flags_protective(self):
        comp = self._valid_comp()
        object.__setattr__(comp, "protective_execution_included", True)
        self._recompute_id(comp)
        with self.assertRaises(ValueError) as ctx:
            Stage5IntentCompilation.__post_init__(comp)
        self.assertIn("COMPILATION_PROTECTIVE_NOT_FALSE", str(ctx.exception))

    def test_flags_replay(self):
        comp = self._valid_comp()
        object.__setattr__(comp, "replay_compatible", True)
        self._recompute_id(comp)
        with self.assertRaises(ValueError) as ctx:
            Stage5IntentCompilation.__post_init__(comp)
        self.assertIn("COMPILATION_REPLAY_NOT_FALSE", str(ctx.exception))

    def test_flags_bridge(self):
        comp = self._valid_comp()
        object.__setattr__(comp, "requires_protective_state_bridge", False)
        self._recompute_id(comp)
        with self.assertRaises(ValueError) as ctx:
            Stage5IntentCompilation.__post_init__(comp)
        self.assertIn("COMPILATION_BRIDGE_NOT_TRUE", str(ctx.exception))


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

    def _recompute_id(self, comp):
        from quant_engine.proof.stage5_intent_compiler import _compilation_payload
        object.__setattr__(comp, "compilation_id", canonical_sha256(_compilation_payload(comp)))

    def test_tamper_max_holding_rejected(self):
        comp = self._compile_2trade()
        object.__setattr__(comp, "max_holding_bars", True)
        self._recompute_id(comp)
        with self.assertRaises(ValueError) as ctx:
            Stage5IntentCompilation.__post_init__(comp)
        self.assertIn("MAX_HOLD", str(ctx.exception))

    def test_tamper_scope_rejected(self):
        comp = self._compile_2trade()
        object.__setattr__(comp, "scope", "FORGED")
        self._recompute_id(comp)
        with self.assertRaises(ValueError):
            Stage5IntentCompilation.__post_init__(comp)

    def test_tamper_duplicate_obs_ids_rejected(self):
        comp = self._compile_2trade()
        new_ids = (comp.observation_ids[0], comp.observation_ids[0]) + comp.observation_ids[2:]
        object.__setattr__(comp, "observation_ids", new_ids)
        self._recompute_id(comp)
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

    def test_tamper_flags_rejected(self):
        comp = self._compile_2trade()
        object.__setattr__(comp, "protective_execution_included", True)
        self._recompute_id(comp)
        with self.assertRaises(ValueError):
            Stage5IntentCompilation.__post_init__(comp)

    def test_tamper_plan_rejected(self):
        comp = self._compile_2trade()
        object.__setattr__(comp, "plan", None)
        with self.assertRaises(ValueError):
            Stage5IntentCompilation.__post_init__(comp)


class VerifyExtendedTests(unittest.TestCase):
    def _compile(self, obs, max_holding=96, scored_end=F * 10):
        return compile_stage5_strategy_intent(
            strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID,
            symbol=_SYM, warmup_bars=30, max_holding_bars=max_holding,
            scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=scored_end,
            terminal_execution_bar_open_time_ms=scored_end, observations=obs,
        )

    def test_verify_max_holding_mismatch(self):
        obs = tuple(_obs(i * F, le=(i == 0), lx=(i == 5)) for i in range(9))
        comp = self._compile(obs, max_holding=96)
        with self.assertRaises(ValueError):
            verify_stage5_intent_compilation(
                compilation=comp, strategy_id=_SID, spec_id=_SPID, parameter_id=_PID,
                dataset_id=_DID, symbol=_SYM, warmup_bars=30, max_holding_bars=50,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, observations=obs,
            )

    def test_verify_obs_lineage_mismatch(self):
        obs = tuple(_obs(i * F, le=(i == 0), lx=(i == 5)) for i in range(9))
        comp = self._compile(obs)
        with self.assertRaises(ValueError):
            verify_stage5_intent_compilation(
                compilation=comp, strategy_id=_SID, spec_id=_SPID, parameter_id=_PID,
                dataset_id=_DID, symbol="FORGED", warmup_bars=30, max_holding_bars=96,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, observations=obs,
            )


class TransitiveImportTests(unittest.TestCase):
    def test_transitive_no_forbidden_modules(self):
        import ast, importlib.util, os
        forbidden = {"strategy_adapter", "stage5_harness", "stage5r1_replay",
                     "stage5r1_protective_replay", "numpy", "pandas",
                     "stage5r1_capital", "stage5r1_metrics", "indicators"}
        required = {"quant_engine.proof.stage5_intent_compiler",
                    "quant_engine.proof.stage5_lifecycle_plan",
                    "quant_engine.proof.stage5_evaluation"}
        visited = set()
        parsed = set()
        queue = ["quant_engine.proof.stage5_intent_compiler"]

        while queue:
            mod_name = queue.pop(0)
            if mod_name in visited:
                continue
            visited.add(mod_name)
            try:
                spec = importlib.util.find_spec(mod_name)
            except Exception as e:
                self.fail(f"find_spec failed for {mod_name}: {e}")
            if spec is None or spec.origin is None:
                self.fail(f"No spec/origin for {mod_name}")
            path = os.path.realpath(spec.origin)
            proj_root = os.path.realpath(os.path.join(os.path.dirname(__file__), ".."))
            if not path.startswith(proj_root):
                continue
            try:
                with open(path) as f:
                    tree = ast.parse(f.read())
            except Exception as e:
                self.fail(f"Parse error in {path}: {e}")
            parsed.add(mod_name)

            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name.startswith("quant_engine"):
                            queue.append(alias.name)
                elif isinstance(node, ast.ImportFrom):
                    if node.module and node.module.startswith("quant_engine"):
                        queue.append(node.module)

        for req in required:
            self.assertIn(req, parsed, f"Required module not parsed: {req}")
        found = {m for fbd in forbidden for m in visited if fbd in m}
        self.assertEqual(found, set(), f"Forbidden in transitive: {found}")

    def test_direct_ast_no_dangerous_ops(self):
        import ast, os
        dangerous_imports = {"strategy_adapter", "stage5_harness", "stage5r1_replay",
                             "stage5r1_protective_replay", "numpy", "pandas", "indicators"}
        dangerous_calls = {"open", "subprocess", "socket", "requests", "urlopen",
                           "StrategyAdapter", "Path", "os"}
        impl = os.path.join(os.path.dirname(__file__), "..", "proof", "stage5_intent_compiler.py")
        with open(impl) as f:
            tree = ast.parse(f.read())
        imports = set()
        call_names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.update(a.name for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.add(node.module)
            elif isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name):
                    call_names.add(node.func.id)
                elif isinstance(node.func, ast.Attribute):
                    call_names.add(node.func.attr)
        hit_imports = dangerous_imports & imports
        hit_calls = dangerous_calls & call_names
        self.assertEqual(hit_imports, set(), f"Dangerous imports: {hit_imports}")
        self.assertEqual(hit_calls, set(), f"Dangerous calls: {hit_calls}")


if __name__ == "__main__":
    unittest.main()
