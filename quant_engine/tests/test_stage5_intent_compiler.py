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


def _obs(signal_time, has_outputs=True, le=False, se=False, lx=False, sx=False):
    return create_stage5_strategy_intent_observation(
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


class CompilerTests(unittest.TestCase):
    def _compile(self, obs, max_holding=96, scored_end=F * 10):
        return compile_stage5_strategy_intent(
            strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID,
            symbol="BTC/USDT", warmup_bars=30, max_holding_bars=max_holding,
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
            symbol="BTC/USDT", warmup_bars=30, max_holding_bars=96,
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
            dataset_id=_DID, symbol="BTC/USDT", warmup_bars=30, max_holding_bars=96,
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
                symbol="BTC/USDT", warmup_bars=30, max_holding_bars=True,
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
        # short_entry has priority; exit fires only when no short_entry
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
                strategy_id=BadStr("s" * 64), spec_id=_SPID, parameter_id=_PID, dataset_id=_DID,
                symbol="BTC/USDT", warmup_bars=30, max_holding_bars=96,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, observations=self._obs_9(),
            )

    def test_negative_warmup_rejected(self):
        with self.assertRaises(ValueError):
            compile_stage5_strategy_intent(
                strategy_id=_SID, spec_id=_SPID, parameter_id=_PID, dataset_id=_DID,
                symbol="BTC/USDT", warmup_bars=0, max_holding_bars=96,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, observations=self._obs_9(),
            )

    def test_obs_outside_window_rejected(self):
        obs = tuple(_obs(i * F + F) for i in range(9))  # starts at F, not 0
        with self.assertRaises(ValueError):
            self._compile(obs, scored_end=F * 10)


if __name__ == "__main__":
    unittest.main()
