"""Deterministic offline replay for Stage 5 research candidates.

The records emitted here are research records, never Paper or exchange fills.
"""

from __future__ import annotations

import json
import math
import statistics
from dataclasses import asdict
from typing import Any, Mapping, Protocol, Sequence

import pandas as pd

from quant_engine.proof.stage5_evaluation import canonical_json_bytes, canonical_sha256
from quant_engine.proof.strategy_adapter import Action, Decision, StrategyContext
from quant_engine.proof.strategy_spec import CompiledStrategyAdapter, StrategySpec


METRICS = (
    "grossReturn", "netReturn", "maximumDrawdown", "sharpe", "sortino",
    "profitFactor", "winRate", "averageWin", "averageLoss", "expectancy",
    "turnover", "tradeCount", "exposure", "fees", "spreadCost",
    "slippageCost", "fundingCost", "mfe", "mae", "rMultiple",
)


class OfflineAdapter(Protocol):
    strategy_id: str
    version: str
    minimum_history: int

    def decide(self, history: pd.DataFrame, parameters: Mapping[str, Any], context: StrategyContext) -> Action | Decision: ...


class RegisteredOfflineAdapter(CompiledStrategyAdapter):
    """Indexed equivalent of ``CompiledStrategyAdapter`` for bounded research.

    Component outputs and ATR values are causal vector calculations.  The
    indexed path avoids allocating a pandas history frame for every bar while
    preserving the exact public ``decide`` semantics.
    """

    def __init__(self, spec: StrategySpec):
        super().__init__(spec)
        self._bars: pd.DataFrame | None = None
        self._atr_cache: dict[tuple[str, str], float] = {}

    def prime(self, bars: pd.DataFrame, parameters: Mapping[str, Any]) -> None:
        super().prime(bars, parameters)
        self._bars = bars.copy(deep=True)
        parameter_key = canonical_sha256(parameters)
        previous = bars["close"].shift(1)
        true_range = pd.concat((
            bars["high"] - bars["low"],
            (bars["high"] - previous).abs(),
            (bars["low"] - previous).abs(),
        ), axis=1).max(axis=1)
        atr = true_range.rolling(int(parameters["atr_period"]), min_periods=1).mean()
        for index in range(len(bars)):
            timestamp = pd.Timestamp(bars.iloc[index]["date"]).isoformat()
            self._atr_cache[(parameter_key, timestamp)] = float(atr.iloc[index])

    def decide_at(self, bar_index: int, parameters: Mapping[str, Any], context: StrategyContext) -> Action | Decision:
        if self._bars is None or not (0 <= bar_index < len(self._bars)):
            raise ValueError("OFFLINE_INDEXED_ADAPTER_NOT_PRIMED")
        allowed = {canonical_json_bytes(item) for item in self.spec.parameters["candidateSets"]}
        if canonical_json_bytes(dict(parameters)) not in allowed:
            raise ValueError("STRATEGY_PARAMETERS_NOT_DECLARED")
        timestamp = pd.Timestamp(self._bars.iloc[bar_index]["date"]).isoformat()
        parameter_key = canonical_sha256(parameters)
        outputs = self._output_cache.get((parameter_key, timestamp), {})
        if not outputs:
            return Action.HOLD
        long_entry = self._entry("long", outputs)
        short_entry = self._entry("short", outputs)
        if long_entry and short_entry:
            return Action.HOLD

        def entry(action: Action) -> Decision:
            stop = self._atr_cache[(parameter_key, timestamp)] * float(parameters["stop_atr"])
            if not stop > 0:
                return Decision(Action.HOLD)
            return Decision(action, stop_distance=stop, take_profit_distance=stop * float(parameters["reward_risk"]))

        maximum_holding = int(parameters["max_holding_bars"])
        if context.position == 1:
            if short_entry:
                return entry(Action.ENTER_SHORT)
            return Action.EXIT if self._exit("long", outputs) or context.bars_held >= maximum_holding else Action.HOLD
        if context.position == -1:
            if long_entry:
                return entry(Action.ENTER_LONG)
            return Action.EXIT if self._exit("short", outputs) or context.bars_held >= maximum_holding else Action.HOLD
        if long_entry:
            return entry(Action.ENTER_LONG)
        if short_entry:
            return entry(Action.ENTER_SHORT)
        return Action.HOLD


def bars_from_binance_rows(rows: Sequence[Sequence[Any]]) -> pd.DataFrame:
    values = []
    for row in rows:
        if not isinstance(row, Sequence) or isinstance(row, (str, bytes, bytearray)) or len(row) != 12:
            raise ValueError("OFFLINE_KLINE_SHAPE_INVALID")
        values.append({
            "date": pd.to_datetime(int(row[0]), unit="ms", utc=True),
            "open": float(row[1]), "high": float(row[2]), "low": float(row[3]),
            "close": float(row[4]), "volume": float(row[5]),
        })
    bars = pd.DataFrame(values, columns=["date", "open", "high", "low", "close", "volume"])
    if bars.empty or not bars["date"].is_monotonic_increasing or bars["date"].duplicated().any():
        raise ValueError("OFFLINE_KLINE_TIME_INVALID")
    numeric = bars[["open", "high", "low", "close", "volume"]]
    if not numeric.map(math.isfinite).all().all() or (numeric[["open", "high", "low", "close"]] <= 0).any().any() or (numeric["volume"] < 0).any():
        raise ValueError("OFFLINE_KLINE_VALUE_INVALID")
    if (bars["high"] < bars[["open", "close", "low"]].max(axis=1)).any() or (bars["low"] > bars[["open", "close", "high"]].min(axis=1)).any():
        raise ValueError("OFFLINE_KLINE_OHLC_INVALID")
    return bars


def _round(value: float) -> float:
    return round(0.0 if value == 0 else float(value), 12)


def _daily_risk_metrics(equity: Sequence[Mapping[str, Any]]) -> tuple[float, float]:
    daily: dict[str, float] = {}
    for point in equity:
        daily[str(point["timestamp"])[:10]] = float(point["equity"])
    values = list(daily.values())
    returns = [values[index] / values[index - 1] - 1 for index in range(1, len(values)) if values[index - 1] > 0]
    if len(returns) < 2:
        return 0.0, 0.0
    mean = statistics.fmean(returns)
    deviation = statistics.pstdev(returns)
    downside = [min(item, 0.0) for item in returns]
    downside_deviation = math.sqrt(statistics.fmean(item * item for item in downside))
    sharpe = 0.0 if deviation == 0 else mean / deviation * math.sqrt(365)
    sortino = 0.0 if downside_deviation == 0 else mean / downside_deviation * math.sqrt(365)
    return _round(sharpe), _round(sortino)


def run_offline_replay(
    adapter: OfflineAdapter,
    bars: pd.DataFrame,
    parameters: Mapping[str, Any],
    start: int,
    end_exclusive: int,
    cost_model: Mapping[str, Any],
) -> dict[str, Any]:
    if not isinstance(bars, pd.DataFrame) or not (0 <= start < end_exclusive <= len(bars)):
        raise ValueError("OFFLINE_WINDOW_INVALID")
    if start < int(adapter.minimum_history) or end_exclusive - start < 2:
        raise ValueError("OFFLINE_WARMUP_OR_WINDOW_INVALID")
    required_costs = ("feeBpsPerFill", "halfSpreadBpsPerFill", "slippageBpsPerFill", "fundingBpsPer8hAdverse")
    if set(cost_model) != set(required_costs):
        raise ValueError("OFFLINE_COST_MODEL_KEYS_INVALID")
    costs = {key: float(cost_model[key]) for key in required_costs}
    if any(not math.isfinite(value) or value < 0 for value in costs.values()):
        raise ValueError("OFFLINE_COST_MODEL_INVALID")
    if canonical_json_bytes(parameters) != canonical_json_bytes(json.loads(canonical_json_bytes(parameters))):
        raise ValueError("OFFLINE_PARAMETERS_INVALID")

    position = 0
    entry_index: int | None = None
    entry_raw: float | None = None
    entry_exec: float | None = None
    entry_stop_distance: float | None = None
    stop_price: float | None = None
    take_profit_price: float | None = None
    mfe = 0.0
    mae = 0.0
    pending = Decision(Action.HOLD)
    trades: list[dict[str, Any]] = []
    decisions: list[dict[str, Any]] = []
    realized_equity = 1.0
    equity_curve: list[dict[str, Any]] = []
    exposure_bars = 0
    fill_cost_bps = costs["feeBpsPerFill"] + costs["halfSpreadBpsPerFill"] + costs["slippageBpsPerFill"]
    dates = bars["date"].tolist()
    opens = bars["open"].to_numpy(dtype=float, copy=True)
    highs = bars["high"].to_numpy(dtype=float, copy=True)
    lows = bars["low"].to_numpy(dtype=float, copy=True)
    closes = bars["close"].to_numpy(dtype=float, copy=True)

    def funding_fraction(exit_index: int) -> float:
        held = 0 if entry_index is None else max(exit_index - entry_index, 0)
        return math.floor(held / 96) * costs["fundingBpsPer8hAdverse"] / 10_000

    def close(exit_index: int, raw_price: float, reason: str) -> None:
        nonlocal position, entry_index, entry_raw, entry_exec, entry_stop_distance
        nonlocal stop_price, take_profit_price, mfe, mae, realized_equity
        if position == 0 or entry_index is None or entry_raw is None or entry_exec is None:
            return
        per_fill = fill_cost_bps / 10_000
        exit_exec = raw_price * (1 - per_fill if position == 1 else 1 + per_fill)
        gross = raw_price / entry_raw - 1 if position == 1 else entry_raw / raw_price - 1
        funding = funding_fraction(exit_index)
        net = (exit_exec / entry_exec - 1 if position == 1 else entry_exec / exit_exec - 1) - funding
        risk_fraction = 0.0 if not entry_stop_distance else entry_stop_distance / entry_raw
        trade = {
            "recordType": "OFFLINE_EVALUATION_RECORD",
            "notPaperFill": True,
            "notExchangeFill": True,
            "notRealOrder": True,
            "side": "long" if position == 1 else "short",
            "entryIndex": entry_index,
            "exitIndex": exit_index,
            "entryPrice": _round(entry_raw),
            "exitPrice": _round(raw_price),
            "grossReturn": _round(gross),
            "netReturn": _round(net),
            "fees": _round(2 * costs["feeBpsPerFill"] / 10_000),
            "spreadCost": _round(2 * costs["halfSpreadBpsPerFill"] / 10_000),
            "slippageCost": _round(2 * costs["slippageBpsPerFill"] / 10_000),
            "fundingCost": _round(funding),
            "mfe": _round(mfe),
            "mae": _round(mae),
            "rMultiple": _round(0.0 if risk_fraction == 0 else net / risk_fraction),
            "exitReason": reason,
        }
        trade["tradeId"] = canonical_sha256(trade)
        trades.append(trade)
        realized_equity *= max(1 + net, 0.0)
        position, entry_index, entry_raw, entry_exec = 0, None, None, None
        entry_stop_distance, stop_price, take_profit_price, mfe, mae = None, None, None, 0.0, 0.0

    for bar_index in range(start, end_exclusive):
        execution_open = float(opens[bar_index])
        target = position
        if pending.action is Action.ENTER_LONG:
            target = 1
        elif pending.action is Action.ENTER_SHORT:
            target = -1
        elif pending.action is Action.EXIT:
            target = 0
        if target != position:
            close(bar_index, execution_open, "signal")
        if target != 0 and position == 0:
            position = target
            entry_index = bar_index
            entry_raw = execution_open
            per_fill = fill_cost_bps / 10_000
            entry_exec = execution_open * (1 + per_fill if target == 1 else 1 - per_fill)
            entry_stop_distance = pending.stop_distance
            stop_price = None if pending.stop_distance is None else execution_open + (-pending.stop_distance if target == 1 else pending.stop_distance)
            take_profit_price = None if pending.take_profit_distance is None else execution_open + (pending.take_profit_distance if target == 1 else -pending.take_profit_distance)

        if position != 0 and entry_raw is not None:
            exposure_bars += 1
            favorable = float(highs[bar_index]) / entry_raw - 1 if position == 1 else entry_raw / float(lows[bar_index]) - 1
            adverse = float(lows[bar_index]) / entry_raw - 1 if position == 1 else entry_raw / float(highs[bar_index]) - 1
            mfe, mae = max(mfe, favorable), min(mae, adverse)
        if position == 1 and stop_price is not None and float(lows[bar_index]) <= stop_price:
            close(bar_index, min(execution_open, stop_price), "stop")
        elif position == -1 and stop_price is not None and float(highs[bar_index]) >= stop_price:
            close(bar_index, max(execution_open, stop_price), "stop")
        elif position == 1 and take_profit_price is not None and float(highs[bar_index]) >= take_profit_price:
            close(bar_index, max(execution_open, take_profit_price), "take-profit")
        elif position == -1 and take_profit_price is not None and float(lows[bar_index]) <= take_profit_price:
            close(bar_index, min(execution_open, take_profit_price), "take-profit")

        mark = realized_equity
        if position != 0 and entry_exec is not None:
            per_fill = fill_cost_bps / 10_000
            raw_close = float(closes[bar_index])
            marked_exit = raw_close * (1 - per_fill if position == 1 else 1 + per_fill)
            open_return = marked_exit / entry_exec - 1 if position == 1 else entry_exec / marked_exit - 1
            mark *= max(1 + open_return - funding_fraction(bar_index), 0.0)
        equity_curve.append({"index": bar_index, "timestamp": pd.Timestamp(dates[bar_index]).isoformat(), "equity": _round(mark)})

        pending = Decision(Action.HOLD)
        if bar_index >= end_exclusive - 1:
            continue
        held = 0 if entry_index is None else bar_index - entry_index + 1
        context = StrategyContext(position, entry_exec, stop_price, take_profit_price, held)
        decide_at = getattr(adapter, "decide_at", None)
        if callable(decide_at):
            raw = decide_at(bar_index, parameters, context)
        else:
            history_limit = getattr(adapter, "history_limit", None)
            history_start = 0 if history_limit is None else max(0, bar_index + 1 - int(history_limit))
            history = bars.iloc[history_start:bar_index + 1].copy(deep=True)
            raw = adapter.decide(history, parameters, context)
        pending = Decision(raw) if isinstance(raw, Action) else raw
        if not isinstance(pending, Decision) or not isinstance(pending.action, Action):
            raise ValueError("OFFLINE_DECISION_INVALID")
        if pending.stop_distance is not None and (
            pending.action not in (Action.ENTER_LONG, Action.ENTER_SHORT)
            or not math.isfinite(pending.stop_distance)
            or pending.stop_distance <= 0
        ):
            raise ValueError("OFFLINE_STOP_DISTANCE_INVALID")
        if pending.take_profit_distance is not None and (
            pending.action not in (Action.ENTER_LONG, Action.ENTER_SHORT)
            or not math.isfinite(pending.take_profit_distance)
            or pending.take_profit_distance <= 0
        ):
            raise ValueError("OFFLINE_TAKE_PROFIT_DISTANCE_INVALID")
        decision_record = {
            "atCloseIndex": bar_index,
            "executeAtOpenIndex": bar_index + 1,
            **asdict(pending),
        }
        decision_record["intentId"] = canonical_sha256({
            "strategyId": adapter.strategy_id,
            "adapterVersion": adapter.version,
            "parameterId": canonical_sha256(parameters),
            **decision_record,
        })
        decisions.append(decision_record)

    close(end_exclusive - 1, float(closes[end_exclusive - 1]), "window-end")
    if equity_curve:
        equity_curve[-1]["equity"] = _round(realized_equity)
    peak, maximum_drawdown, drawdowns = 0.0, 0.0, []
    for point in equity_curve:
        peak = max(peak, float(point["equity"]))
        drawdown = 0.0 if peak <= 0 else (peak - float(point["equity"])) / peak
        maximum_drawdown = max(maximum_drawdown, drawdown)
        drawdowns.append({"index": point["index"], "drawdown": _round(drawdown)})
    gross_equity = math.prod(1 + float(item["grossReturn"]) for item in trades)
    net_returns = [float(item["netReturn"]) for item in trades]
    wins, losses = [item for item in net_returns if item > 0], [item for item in net_returns if item < 0]
    profit_factor = sum(wins) / abs(sum(losses)) if losses else (1_000_000.0 if wins else 0.0)
    sharpe, sortino = _daily_risk_metrics(equity_curve)
    metrics = {
        "grossReturn": _round(gross_equity - 1),
        "netReturn": _round(realized_equity - 1),
        "maximumDrawdown": _round(maximum_drawdown),
        "sharpe": sharpe,
        "sortino": sortino,
        "profitFactor": _round(profit_factor),
        "winRate": _round(0.0 if not trades else len(wins) / len(trades)),
        "averageWin": _round(0.0 if not wins else statistics.fmean(wins)),
        "averageLoss": _round(0.0 if not losses else statistics.fmean(losses)),
        "expectancy": _round(0.0 if not net_returns else statistics.fmean(net_returns)),
        "turnover": _round(2.0 * len(trades)),
        "tradeCount": len(trades),
        "exposure": _round(exposure_bars / (end_exclusive - start)),
        "fees": _round(sum(float(item["fees"]) for item in trades)),
        "spreadCost": _round(sum(float(item["spreadCost"]) for item in trades)),
        "slippageCost": _round(sum(float(item["slippageCost"]) for item in trades)),
        "fundingCost": _round(sum(float(item["fundingCost"]) for item in trades)),
        "mfe": _round(0.0 if not trades else statistics.fmean(float(item["mfe"]) for item in trades)),
        "mae": _round(0.0 if not trades else statistics.fmean(float(item["mae"]) for item in trades)),
        "rMultiple": _round(0.0 if not trades else statistics.fmean(float(item["rMultiple"]) for item in trades)),
    }
    if tuple(metrics) != METRICS:
        raise ValueError("OFFLINE_METRIC_CONTRACT_INVALID")
    result: dict[str, Any] = {
        "schemaVersion": "stage-5.offline-evaluation.v1",
        "labels": ["OFFLINE_EVALUATION_RECORD", "NOT_A_PAPER_FILL", "NOT_AN_EXCHANGE_FILL", "NOT_A_REAL_ORDER"],
        "strategyId": adapter.strategy_id,
        "adapterVersion": adapter.version,
        "parameterId": canonical_sha256(parameters),
        "parameters": json.loads(canonical_json_bytes(parameters)),
        "window": {"start": start, "endExclusive": end_exclusive, "executionTiming": "closed-bar-next-open", "latencyBars": 1},
        "costModel": json.loads(canonical_json_bytes(cost_model)),
        "metrics": metrics,
        "capacityProxy": {
            "method": "TURNOVER_AND_EXPOSURE_ONLY",
            "turnover": metrics["turnover"],
            "exposure": metrics["exposure"],
            "marketDepthAssumed": False,
        },
        "tradeRecords": trades,
        "equityCurve": equity_curve,
        "drawdownSeries": drawdowns,
        "digests": {"trades": canonical_sha256(trades), "equityCurve": canonical_sha256(equity_curve), "drawdownSeries": canonical_sha256(drawdowns), "decisions": canonical_sha256(decisions), "intentIdentities": canonical_sha256([item["intentId"] for item in decisions])},
        "safety": {"offlineOnly": True, "paperTestnetLiveCalls": 0, "activationAuthorized": False, "runtimeStarted": False, "paperApproved": False, "testnetApproved": False, "liveApproved": False},
    }
    result["resultId"] = canonical_sha256(result)
    return result


def strategy_spec_from_registry(candidate: Mapping[str, Any]) -> StrategySpec:
    spec = candidate.get("spec")
    if not isinstance(spec, Mapping) or spec.get("strategyId") != candidate.get("strategyId") or spec.get("specId") != candidate.get("specId"):
        raise ValueError("OFFLINE_CANDIDATE_SPEC_INVALID")
    unsigned = dict(spec)
    identity = unsigned.pop("specId")
    if identity != canonical_sha256(unsigned):
        raise ValueError("OFFLINE_CANDIDATE_SPEC_ID_INVALID")
    return StrategySpec(
        strategy_id=str(spec["strategyId"]), version=str(spec["version"]),
        components=tuple(spec["components"]), entry_rules=tuple(spec["entryRules"]), exit_rules=tuple(spec["exitRules"]),
        position_lifecycle=spec["positionLifecycle"], risk_rules=spec["riskRules"], timeframe=tuple(spec["timeframe"]),
        symbols=tuple(spec["symbols"]), parameters=spec["parameters"], warmup_bars=int(spec["warmupBars"]),
        execution_timing=str(spec["executionTiming"]), cost_model=spec["costModel"], source_asset_digests=spec["sourceAssetDigests"],
    )


def evaluate_registered_candidate(
    registry: Mapping[str, Any], strategy_id: str, parameter_id: str,
    bars: pd.DataFrame, start: int, end_exclusive: int, cost_model: Mapping[str, Any],
) -> dict[str, Any]:
    candidates = [item for item in registry.get("candidates", []) if item.get("strategyId") == strategy_id]
    if len(candidates) != 1 or candidates[0].get("status") != "REGISTERED":
        raise ValueError("OFFLINE_CANDIDATE_NOT_REGISTERED")
    parameter_sets = [item for item in candidates[0]["parameterSets"] if item.get("parameterId") == parameter_id]
    if len(parameter_sets) != 1 or canonical_sha256(parameter_sets[0]["values"]) != parameter_id:
        raise ValueError("OFFLINE_PARAMETER_NOT_REGISTERED")
    spec = strategy_spec_from_registry(candidates[0])
    adapter = RegisteredOfflineAdapter(spec)
    causal_bars = bars.iloc[:end_exclusive].copy(deep=True)
    adapter.prime(causal_bars, parameter_sets[0]["values"])
    return run_offline_replay(adapter, causal_bars, parameter_sets[0]["values"], start, end_exclusive, cost_model)
