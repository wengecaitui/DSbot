"""Stage 5.4-A lifecycle instruction plan — TDD test gates."""

import math
import unittest

from quant_engine.proof.stage5_lifecycle_plan import (
    Stage5LifecycleAction,
    Stage5LifecycleOrigin,
    Stage5LifecycleInstruction,
    Stage5LifecyclePlan,
    create_stage5_lifecycle_instruction,
    build_stage5_lifecycle_plan,
    verify_stage5_lifecycle_plan,
)
from quant_engine.proof.stage5_evaluation import canonical_sha256

F = 300_000  # timeframe_ms = 5min


class InstructionTests(unittest.TestCase):
    def test_enter_long_instruction(self):
        inst = create_stage5_lifecycle_instruction(
            signal_bar_open_time_ms=0,
            action=Stage5LifecycleAction.ENTER_LONG,
            origin=Stage5LifecycleOrigin.STRATEGY,
        )
        self.assertEqual(inst.action, Stage5LifecycleAction.ENTER_LONG)
        self.assertEqual(inst.execution_bar_open_time_ms, F)
        self.assertIsInstance(inst.instruction_id, str)
        self.assertEqual(len(inst.instruction_id), 64)

    def test_exit_instruction(self):
        inst = create_stage5_lifecycle_instruction(
            signal_bar_open_time_ms=F,
            action=Stage5LifecycleAction.EXIT,
            origin=Stage5LifecycleOrigin.STRATEGY,
        )
        self.assertEqual(inst.execution_bar_open_time_ms, 2 * F)

    def test_terminal_exit_requires_terminal_origin(self):
        with self.assertRaises(ValueError):
            create_stage5_lifecycle_instruction(
                signal_bar_open_time_ms=F,
                action=Stage5LifecycleAction.TERMINAL_EXIT,
                origin=Stage5LifecycleOrigin.STRATEGY,
            )

    def test_terminal_origin_only_terminal_exit(self):
        for action in Stage5LifecycleAction:
            if action == Stage5LifecycleAction.TERMINAL_EXIT:
                continue
            with self.subTest(action=action):
                with self.assertRaises(ValueError):
                    create_stage5_lifecycle_instruction(
                        signal_bar_open_time_ms=F,
                        action=action,
                        origin=Stage5LifecycleOrigin.TERMINAL_POLICY,
                    )

    def test_negative_signal_time_rejected(self):
        with self.assertRaises(ValueError):
            create_stage5_lifecycle_instruction(
                signal_bar_open_time_ms=-1,
                action=Stage5LifecycleAction.ENTER_LONG,
                origin=Stage5LifecycleOrigin.STRATEGY,
            )

    def test_bool_is_not_int_rejected(self):
        with self.assertRaises(ValueError):
            create_stage5_lifecycle_instruction(
                signal_bar_open_time_ms=True,
                action=Stage5LifecycleAction.ENTER_LONG,
                origin=Stage5LifecycleOrigin.STRATEGY,
            )

    def test_deterministic_id(self):
        a = create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY)
        b = create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY)
        self.assertEqual(a.instruction_id, b.instruction_id)
        self.assertEqual(a, b)

    def test_different_origin_different_id(self):
        a = create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.TERMINAL_EXIT, Stage5LifecycleOrigin.TERMINAL_POLICY)
        b = create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY)
        self.assertNotEqual(a.instruction_id, b.instruction_id)


class PlanConstructionTests(unittest.TestCase):
    _SID = "a" * 64
    _SPID = "b" * 64
    _PID = "c" * 64
    _DID = "d" * 64

    def _plan(self, instructions, scored_end=F * 10):
        return build_stage5_lifecycle_plan(
            strategy_id=self._SID, spec_id=self._SPID, parameter_id=self._PID,
            dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=30,
            scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=scored_end,
            terminal_execution_bar_open_time_ms=scored_end,
            instructions=instructions,
        )

    def test_no_trade_plan(self):
        plan = self._plan(())
        self.assertEqual(plan.instruction_count, 0)
        self.assertEqual(plan.final_state, "FLAT")
        self.assertEqual(plan.initial_state, "FLAT")
        self.assertEqual(plan.reversal_count, 0)
        self.assertEqual(plan.terminal_exit_count, 0)

    def test_long_entry_exit_plan(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        plan = self._plan(insts, F * 10)
        self.assertEqual(plan.instruction_count, 2)
        self.assertEqual(plan.final_state, "FLAT")

    def test_short_entry_exit_plan(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_SHORT, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        plan = self._plan(insts, F * 10)
        self.assertEqual(plan.final_state, "FLAT")

    def test_reverse_to_long(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_SHORT, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.REVERSE_TO_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 8, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        plan = self._plan(insts, F * 10)
        self.assertEqual(plan.reversal_count, 1)
        self.assertEqual(plan.final_state, "FLAT")

    def test_reverse_to_short(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.REVERSE_TO_SHORT, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 8, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        plan = self._plan(insts, F * 10)
        self.assertEqual(plan.reversal_count, 1)

    def test_terminal_exit_long(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 9, Stage5LifecycleAction.TERMINAL_EXIT, Stage5LifecycleOrigin.TERMINAL_POLICY),
        )
        plan = self._plan(insts, F * 10)
        self.assertEqual(plan.terminal_exit_count, 1)
        self.assertEqual(plan.final_state, "FLAT")

    def test_reversal_rejected_exit_enter_same_signal(self):
        """EXIT + ENTER at same signal timestamp rejected (use REVERSE instead)."""
        with self.assertRaises(ValueError):
            self._plan((
                create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
                create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
                create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.ENTER_SHORT, Stage5LifecycleOrigin.STRATEGY),
                create_stage5_lifecycle_instruction(F * 8, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
            ), F * 10)

    def test_missing_terminal_rejected(self):
        """Open position at end without terminal exit is rejected."""
        insts = (create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),)
        with self.assertRaises(ValueError):
            self._plan(insts, F * 10)

    def test_extra_terminal_rejected(self):
        """Two terminal exits rejected."""
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 9, Stage5LifecycleAction.TERMINAL_EXIT, Stage5LifecycleOrigin.TERMINAL_POLICY),
            create_stage5_lifecycle_instruction(F * 9, Stage5LifecycleAction.TERMINAL_EXIT, Stage5LifecycleOrigin.TERMINAL_POLICY),
        )
        with self.assertRaises(ValueError):
            self._plan(insts, F * 10)

    def test_terminal_not_final_rejected(self):
        """Terminal exit must be the last instruction."""
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.TERMINAL_EXIT, Stage5LifecycleOrigin.TERMINAL_POLICY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        with self.assertRaises(ValueError):
            self._plan(insts, F * 10)

    def test_non_terminal_exit_while_flat_rejected(self):
        with self.assertRaises(ValueError):
            self._plan((
                create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
            ), F * 10)

    def test_double_entry_rejected(self):
        with self.assertRaises(ValueError):
            self._plan((
                create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
                create_stage5_lifecycle_instruction(F * 3, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            ), F * 10)

    def test_wrong_side_reverse_rejected(self):
        """REVERSE_TO_LONG when already LONG rejected."""
        with self.assertRaises(ValueError):
            self._plan((
                create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
                create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.REVERSE_TO_LONG, Stage5LifecycleOrigin.STRATEGY),
            ), F * 10)

    def test_deterministic_plan_id(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        a = self._plan(insts, F * 10)
        b = self._plan(insts, F * 10)
        self.assertEqual(a.plan_id, b.plan_id)
        self.assertEqual(a, b)

    def test_caller_input_unchanged(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        self._plan(insts, F * 10)
        self.assertEqual(insts[0].signal_bar_open_time_ms, 0)


class VerifyAPITests(unittest.TestCase):
    _SID = "a" * 64
    _SPID = "b" * 64
    _PID = "c" * 64
    _DID = "d" * 64

    def _plan(self, instructions, scored_end=F * 10):
        return build_stage5_lifecycle_plan(
            strategy_id=self._SID, spec_id=self._SPID, parameter_id=self._PID,
            dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=30,
            scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=scored_end,
            terminal_execution_bar_open_time_ms=scored_end,
            instructions=instructions,
        )

    def test_verify_identity(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        plan = self._plan(insts, F * 10)
        verified = verify_stage5_lifecycle_plan(
            plan=plan, strategy_id=self._SID, spec_id=self._SPID, parameter_id=self._PID,
            dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=30,
            scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
            terminal_execution_bar_open_time_ms=F * 10, instructions=insts,
        )
        self.assertIs(verified, plan)

    def test_verify_rejects_different_inputs(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        plan = self._plan(insts, F * 10)
        with self.assertRaises(ValueError):
            verify_stage5_lifecycle_plan(
                plan=plan, strategy_id="x" * 64, spec_id=self._SPID, parameter_id=self._PID,
                dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=30,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, instructions=insts,
            )

    def test_verify_rejects_forged_plan_id(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        plan = self._plan(insts, F * 10)
        object.__setattr__(plan, "plan_id", "0" * 64)
        with self.assertRaises(ValueError):
            verify_stage5_lifecycle_plan(
                plan=plan, strategy_id=self._SID, spec_id=self._SPID, parameter_id=self._PID,
                dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=30,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, instructions=insts,
            )

    def test_verify_rejects_subclass(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        plan = self._plan(insts, F * 10)
        class FakePlan(Stage5LifecyclePlan): pass
        fake = FakePlan(**{k: getattr(plan, k) for k in plan.__dataclass_fields__})
        with self.assertRaises(ValueError):
            verify_stage5_lifecycle_plan(
                plan=fake, strategy_id=self._SID, spec_id=self._SPID, parameter_id=self._PID,
                dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=30,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, instructions=insts,
            )


class ForgedNestedTests(unittest.TestCase):
    _SID = "a" * 64
    _SPID = "b" * 64
    _PID = "c" * 64
    _DID = "d" * 64

    def _plan(self, instructions, scored_end=F * 10):
        return build_stage5_lifecycle_plan(
            strategy_id=self._SID, spec_id=self._SPID, parameter_id=self._PID,
            dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=30,
            scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=scored_end,
            terminal_execution_bar_open_time_ms=scored_end,
            instructions=instructions,
        )

    def test_forged_instruction_action_rejected(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        plan = self._plan(insts, F * 10)
        object.__setattr__(plan.instructions[0], "action", Stage5LifecycleAction.EXIT)
        with self.assertRaises(ValueError) as ctx:
            verify_stage5_lifecycle_plan(
                plan=plan, strategy_id=self._SID, spec_id=self._SPID, parameter_id=self._PID,
                dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=30,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, instructions=insts,
            )
        self.assertIn("INSTRUCTION_ID_MISMATCH", str(ctx.exception))

    def test_list_instead_of_tuple_rejected(self):
        insts = [
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        ]
        with self.assertRaises(ValueError):
            self._plan(insts, F * 10)

    def test_forged_reversal_count_rejected(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_SHORT, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.REVERSE_TO_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 8, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        plan = self._plan(insts, F * 10)
        object.__setattr__(plan, "reversal_count", 0)
        with self.assertRaises(ValueError) as ctx:
            verify_stage5_lifecycle_plan(
                plan=plan, strategy_id=self._SID, spec_id=self._SPID, parameter_id=self._PID,
                dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=30,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, instructions=insts,
            )
        self.assertIn("REVERSAL_COUNT", str(ctx.exception))

    def test_mixed_terminal_and_strategy_rejected(self):
        with self.assertRaises(ValueError):
            self._plan((
                create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
                create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.TERMINAL_EXIT, Stage5LifecycleOrigin.STRATEGY),
            ), F * 10)

    def test_unsorted_signals_rejected(self):
        insts = (
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        with self.assertRaises(ValueError):
            self._plan(insts, F * 10)

    def test_terminal_exit_while_flat_rejected(self):
        with self.assertRaises(ValueError):
            self._plan((
                create_stage5_lifecycle_instruction(F * 9, Stage5LifecycleAction.TERMINAL_EXIT, Stage5LifecycleOrigin.TERMINAL_POLICY),
            ), F * 10)

    def test_forged_execution_time_rejected(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        plan = self._plan(insts, F * 10)
        object.__setattr__(plan.instructions[0], "execution_bar_open_time_ms", 999)
        with self.assertRaises(ValueError) as ctx:
            verify_stage5_lifecycle_plan(
                plan=plan, strategy_id=self._SID, spec_id=self._SPID, parameter_id=self._PID,
                dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=30,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, instructions=insts,
            )
        self.assertIn("EXECUTION_NOT_NEXT", str(ctx.exception))

    def test_forged_plan_state_rejected(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 9, Stage5LifecycleAction.TERMINAL_EXIT, Stage5LifecycleOrigin.TERMINAL_POLICY),
        )
        plan = self._plan(insts, F * 10)
        object.__setattr__(plan, "final_state", "LONG")
        with self.assertRaises(ValueError) as ctx:
            verify_stage5_lifecycle_plan(
                plan=plan, strategy_id=self._SID, spec_id=self._SPID, parameter_id=self._PID,
                dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=30,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, instructions=insts,
            )
        self.assertIn("FINAL_NOT_FLAT", str(ctx.exception))

    def test_subclass_instruction_rejected(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        class FakeInst(Stage5LifecycleInstruction): pass
        fake = FakeInst(**{k: getattr(insts[0], k) for k in insts[0].__dataclass_fields__})
        with self.assertRaises(ValueError):
            self._plan((fake, insts[1]), F * 10)

    def test_nan_signal_time_rejected(self):
        with self.assertRaises(ValueError):
            create_stage5_lifecycle_instruction(float("nan"), Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY)

    def test_multi_trade_mixed_lifecycle(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 3, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.ENTER_SHORT, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 7, Stage5LifecycleAction.REVERSE_TO_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 9, Stage5LifecycleAction.TERMINAL_EXIT, Stage5LifecycleOrigin.TERMINAL_POLICY),
        )
        plan = self._plan(insts, F * 10)
        self.assertEqual(plan.instruction_count, 5)
        self.assertEqual(plan.reversal_count, 1)
        self.assertEqual(plan.terminal_exit_count, 1)

    def test_signal_at_scored_end_rejected(self):
        """Signal at end_exclusive (not < end) rejected."""
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 10, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        with self.assertRaises(ValueError):
            self._plan(insts, F * 10)

    def test_execution_beyond_terminal_rejected(self):
        """Execution beyond terminal rejected."""
        insts = (
            create_stage5_lifecycle_instruction(F * 8, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 9, Stage5LifecycleAction.TERMINAL_EXIT, Stage5LifecycleOrigin.TERMINAL_POLICY),
        )
        with self.assertRaises(ValueError):
            build_stage5_lifecycle_plan(
                strategy_id=self._SID, spec_id=self._SPID, parameter_id=self._PID,
                dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=30,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 8,
                terminal_execution_bar_open_time_ms=F * 8,
                instructions=insts,
            )

    def test_terminal_wrong_signal_offset_rejected(self):
        """Terminal signal not at (end_exclusive - timeframe) rejected."""
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 8, Stage5LifecycleAction.TERMINAL_EXIT, Stage5LifecycleOrigin.TERMINAL_POLICY),
        )
        with self.assertRaises(ValueError):
            self._plan(insts, F * 10)

    def test_forged_strategy_id_rejected(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        plan = self._plan(insts, F * 10)
        with self.assertRaises(ValueError):
            verify_stage5_lifecycle_plan(
                plan=plan, strategy_id="x" * 64, spec_id=self._SPID, parameter_id=self._PID,
                dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=30,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, instructions=insts,
            )

    def test_forged_symbol_rejected(self):
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 5, Stage5LifecycleAction.EXIT, Stage5LifecycleOrigin.STRATEGY),
        )
        plan = self._plan(insts, F * 10)
        with self.assertRaises(ValueError):
            verify_stage5_lifecycle_plan(
                plan=plan, strategy_id=self._SID, spec_id=self._SPID, parameter_id=self._PID,
                dataset_id=self._DID, symbol="FORGED", warmup_bars=30,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, instructions=insts,
            )

    def test_bool_as_warmup_rejected(self):
        with self.assertRaises(ValueError):
            build_stage5_lifecycle_plan(
                strategy_id=self._SID, spec_id=self._SPID, parameter_id=self._PID,
                dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=True,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, instructions=(),
            )

    def test_empty_string_strategy_rejected(self):
        with self.assertRaises(ValueError):
            build_stage5_lifecycle_plan(
                strategy_id="", spec_id=self._SPID, parameter_id=self._PID,
                dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=30,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, instructions=(),
            )


class FactoryTypeBoundaryTests(unittest.TestCase):
    def test_factory_rejects_wrong_action_string(self):
        with self.assertRaises(ValueError) as ctx:
            create_stage5_lifecycle_instruction(0, "enter-long", Stage5LifecycleOrigin.STRATEGY)
        self.assertIn("ACTION_INVALID", str(ctx.exception))

    def test_factory_rejects_wrong_origin_string(self):
        with self.assertRaises(ValueError) as ctx:
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, "strategy")
        self.assertIn("ORIGIN_INVALID", str(ctx.exception))

    def test_factory_rejects_none_action(self):
        with self.assertRaises(ValueError) as ctx:
            create_stage5_lifecycle_instruction(0, None, Stage5LifecycleOrigin.STRATEGY)
        self.assertIn("ACTION_INVALID", str(ctx.exception))

    def test_factory_rejects_bool_as_signal(self):
        with self.assertRaises(ValueError) as ctx:
            create_stage5_lifecycle_instruction(True, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY)
        self.assertIn("SIGNAL_TYPE", str(ctx.exception))


class TimeAlignmentTests(unittest.TestCase):
    _SID = "a" * 64
    _SPID = "b" * 64
    _PID = "c" * 64
    _DID = "d" * 64
    _SCHEMA = None

    @classmethod
    def setUpClass(cls):
        from quant_engine.proof.stage5_lifecycle_plan import SCHEMA
        cls._SCHEMA = SCHEMA

    def _inst(self, signal_ms, action, origin):
        """Direct construction with recomputed instruction_id at unaligned times."""
        from quant_engine.proof.stage5_lifecycle_plan import _instruction_payload, TIMEFRAME
        execution_ms = signal_ms + TIMEFRAME
        p = {
            "schemaVersion": self._SCHEMA,
            "signalBarOpenTimeMs": signal_ms,
            "executionBarOpenTimeMs": execution_ms,
            "action": action.value,
            "origin": origin.value,
        }
        return Stage5LifecycleInstruction(
            schema_version=self._SCHEMA,
            signal_bar_open_time_ms=signal_ms,
            execution_bar_open_time_ms=execution_ms,
            action=action,
            origin=origin,
            instruction_id=canonical_sha256(p),
        )

    def test_unaligned_signal_rejected(self):
        inst = self._inst(150_000, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY)
        with self.assertRaises(ValueError) as ctx:
            build_stage5_lifecycle_plan(
                strategy_id=self._SID, spec_id=self._SPID, parameter_id=self._PID,
                dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=30,
                scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
                terminal_execution_bar_open_time_ms=F * 10, instructions=(inst,),
            )
        self.assertIn("SIGNAL_NOT_ALIGNED", str(ctx.exception))


class TerminalCountClosureTests(unittest.TestCase):
    _SID = "a" * 64
    _SPID = "b" * 64
    _PID = "c" * 64
    _DID = "d" * 64

    def test_forged_terminal_count_rejected(self):
        """Mutate terminal_exit_count, recompute plan_id, prove TERMINAL_COUNT_MISMATCH before PLAN_ID."""
        from quant_engine.proof.stage5_lifecycle_plan import _plan_payload
        insts = (
            create_stage5_lifecycle_instruction(0, Stage5LifecycleAction.ENTER_LONG, Stage5LifecycleOrigin.STRATEGY),
            create_stage5_lifecycle_instruction(F * 9, Stage5LifecycleAction.TERMINAL_EXIT, Stage5LifecycleOrigin.TERMINAL_POLICY),
        )
        plan = build_stage5_lifecycle_plan(
            strategy_id=self._SID, spec_id=self._SPID, parameter_id=self._PID,
            dataset_id=self._DID, symbol="BTC/USDT", warmup_bars=30,
            scored_start_open_time_ms=0, scored_end_exclusive_open_time_ms=F * 10,
            terminal_execution_bar_open_time_ms=F * 10, instructions=insts,
        )
        # actual terminal count is 1, forge to 0
        object.__setattr__(plan, "terminal_exit_count", 0)
        new_id = canonical_sha256(_plan_payload(plan))
        object.__setattr__(plan, "plan_id", new_id)
        with self.assertRaises(ValueError) as ctx:
            Stage5LifecyclePlan.__post_init__(plan)
        self.assertIn("TERMINAL_COUNT_MISMATCH", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
