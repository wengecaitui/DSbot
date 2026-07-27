"""Versioned derived-strategy specifications and deterministic adapters.

The factory combines existing indicator components into new, explicit trading
contracts.  It never changes the classification or semantics of the source
Pine assets.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

import numpy as np
import pandas as pd

from quant_engine.indicators.mean_reversion import calculate as mean_reversion
from quant_engine.indicators.sr_range import calculate as sr_range
from quant_engine.indicators.stc import calculate as stc
from quant_engine.indicators.stochastic import calculate as stochastic
from quant_engine.indicators.trend_impulse import calculate as trend_impulse

from .strategy_adapter import Action, Decision, StrategyContext


SPEC_LABEL = "NEW DERIVED STRATEGY SPEC"
SUPPORTED_EXECUTION_TIMING = "closed-bar-next-open"
_SHA256 = __import__("re").compile(r"^[0-9a-f]{64}$")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class StrategySpec:
    strategy_id: str
    version: str
    components: tuple[Mapping[str, Any], ...]
    entry_rules: tuple[Mapping[str, Any], ...]
    exit_rules: tuple[Mapping[str, Any], ...]
    position_lifecycle: Mapping[str, Any]
    risk_rules: Mapping[str, Any]
    timeframe: tuple[str, ...]
    symbols: tuple[str, ...]
    parameters: Mapping[str, Any]
    warmup_bars: int
    execution_timing: str
    cost_model: Mapping[str, Any]
    source_asset_digests: Mapping[str, Any]

    def to_dict(self) -> dict[str, Any]:
        payload = {
            "label": SPEC_LABEL,
            "strategyId": self.strategy_id,
            "version": self.version,
            "components": [dict(item) for item in self.components],
            "entryRules": [dict(item) for item in self.entry_rules],
            "exitRules": [dict(item) for item in self.exit_rules],
            "positionLifecycle": dict(self.position_lifecycle),
            "riskRules": dict(self.risk_rules),
            "timeframe": list(self.timeframe),
            "symbols": list(self.symbols),
            "parameters": json.loads(json.dumps(self.parameters)),
            "warmupBars": self.warmup_bars,
            "executionTiming": self.execution_timing,
            "costModel": dict(self.cost_model),
            "sourceAssetDigests": json.loads(json.dumps(self.source_asset_digests)),
        }
        payload["specId"] = canonical_sha256(payload)
        return payload


def _rule(side_or_position: str, mode: str, clauses: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    key = "side" if side_or_position in {"long", "short"} and mode == "all" else "position"
    return {key: side_or_position, mode: [dict(item) for item in clauses]}


def _clause(component: str, field: str, value: Any, operator: str = "eq") -> dict[str, Any]:
    return {"component": component, "field": field, "operator": operator, "value": value}


def _template_definitions() -> tuple[dict[str, Any], ...]:
    return (
        {
            "name": "trend-stochastic-confirmation",
            "components": (
                {"assetId": "TrendImpulse", "parameterMap": {"period": "trend_period", "mult": "trend_mult"}},
                {"assetId": "StochasticOverlay", "parameterMap": {"k": "stoch_k", "d": "stoch_d"}},
            ),
            "entry": (
                _rule("long", "all", (_clause("TrendImpulse", "signal", "BULL"), _clause("StochasticOverlay", "signal", "BUY"))),
                _rule("short", "all", (_clause("TrendImpulse", "signal", "BEAR"), _clause("StochasticOverlay", "signal", "SELL"))),
            ),
            "exit": (
                _rule("long", "any", (_clause("TrendImpulse", "signal", "BEAR"),)),
                _rule("short", "any", (_clause("TrendImpulse", "signal", "BULL"),)),
            ),
            "parameterSets": (
                {"trend_period": 21, "trend_mult": 2.0, "stoch_k": 14, "stoch_d": 3, "atr_period": 14, "stop_atr": 1.5, "reward_risk": 2.0, "max_holding_bars": 96},
                {"trend_period": 34, "trend_mult": 2.0, "stoch_k": 14, "stoch_d": 3, "atr_period": 14, "stop_atr": 2.0, "reward_risk": 2.0, "max_holding_bars": 96},
                {"trend_period": 55, "trend_mult": 2.0, "stoch_k": 14, "stoch_d": 3, "atr_period": 14, "stop_atr": 2.5, "reward_risk": 2.0, "max_holding_bars": 96},
            ),
            "warmup": 80,
        },
        {
            "name": "stc-trend-filter",
            "components": (
                {"assetId": "STC", "parameterMap": {"fast": "stc_fast", "slow": "stc_slow", "cycle": "stc_cycle", "d1": "stc_d1", "d2": "stc_d2"}},
                {"assetId": "TrendImpulse", "parameterMap": {"period": "trend_period", "mult": "trend_mult"}},
            ),
            "entry": (
                _rule("long", "all", (_clause("STC", "signal", "BUY"), _clause("TrendImpulse", "signal", "BULL"))),
                _rule("short", "all", (_clause("STC", "signal", "SELL"), _clause("TrendImpulse", "signal", "BEAR"))),
            ),
            "exit": (
                _rule("long", "any", (_clause("STC", "trend", "BEAR"),)),
                _rule("short", "any", (_clause("STC", "trend", "BULL"),)),
            ),
            "parameterSets": (
                {"stc_fast": 18, "stc_slow": 40, "stc_cycle": 10, "stc_d1": 3, "stc_d2": 3, "trend_period": 34, "trend_mult": 2.0, "atr_period": 14, "stop_atr": 1.5, "reward_risk": 2.0, "max_holding_bars": 96},
                {"stc_fast": 23, "stc_slow": 50, "stc_cycle": 10, "stc_d1": 3, "stc_d2": 3, "trend_period": 34, "trend_mult": 2.0, "atr_period": 14, "stop_atr": 2.0, "reward_risk": 2.0, "max_holding_bars": 96},
                {"stc_fast": 28, "stc_slow": 60, "stc_cycle": 12, "stc_d1": 3, "stc_d2": 3, "trend_period": 34, "trend_mult": 2.0, "atr_period": 14, "stop_atr": 2.5, "reward_risk": 2.0, "max_holding_bars": 96},
            ),
            "warmup": 85,
        },
        {
            "name": "mean-reversion-trend-guard",
            "components": (
                {"assetId": "MeanReversion", "parameterMap": {"period": "mean_period", "stdMult": "mean_std"}},
                {"assetId": "TrendImpulse", "parameterMap": {"period": "trend_period", "mult": "trend_mult"}},
            ),
            "entry": (
                _rule("long", "all", (_clause("MeanReversion", "signal", "BUY"), _clause("TrendImpulse", "signal", "BULL"))),
                _rule("short", "all", (_clause("MeanReversion", "signal", "SELL"), _clause("TrendImpulse", "signal", "BEAR"))),
            ),
            "exit": (
                _rule("long", "any", (_clause("MeanReversion", "probability", 0.5, "gte"),)),
                _rule("short", "any", (_clause("MeanReversion", "probability", 0.5, "lte"),)),
            ),
            "parameterSets": tuple(
                {"mean_period": period, "mean_std": 2.0, "trend_period": 34, "trend_mult": 2.0, "atr_period": 14, "stop_atr": stop, "reward_risk": 1.5, "max_holding_bars": 72}
                for period, stop in ((14, 1.5), (20, 2.0), (28, 2.5))
            ),
            "warmup": 70,
        },
        {
            "name": "support-resistance-risk-entry",
            "components": (
                {"assetId": "SRRange", "parameterMap": {"swing_left": "swing_left", "swing_right": "swing_right", "atr_multiplier": "sr_atr"}},
                {"assetId": "TrendImpulse", "parameterMap": {"period": "trend_period", "mult": "trend_mult"}},
            ),
            "entry": (
                _rule("long", "all", (_clause("SRRange", "position", "LONG"), _clause("TrendImpulse", "signal", "BULL"))),
                _rule("short", "all", (_clause("SRRange", "position", "SHORT"), _clause("TrendImpulse", "signal", "BEAR"))),
            ),
            "exit": (
                _rule("long", "any", (_clause("SRRange", "position", "SHORT"),)),
                _rule("short", "any", (_clause("SRRange", "position", "LONG"),)),
            ),
            "parameterSets": tuple(
                {"swing_left": swing, "swing_right": swing, "sr_atr": 1.0, "trend_period": 34, "trend_mult": 2.0, "atr_period": 14, "stop_atr": stop, "reward_risk": 2.0, "max_holding_bars": 96}
                for swing, stop in ((2, 1.5), (3, 2.0), (4, 2.5))
            ),
            "warmup": 80,
        },
    )


def _source_digest(asset: Mapping[str, Any]) -> dict[str, str]:
    return {
        "pineSha256": str(asset["sha256"]),
        "pythonSymbolSha256": str(asset["pythonSymbolSha256"]),
        "registryEntrySha256": str(asset["registryEntrySha256"]),
    }


def build_candidate_specs(asset_manifest: Mapping[str, Any]) -> tuple[StrategySpec, ...]:
    assets = {item["registryName"]: item for item in asset_manifest.get("assets", [])}
    specs: list[StrategySpec] = []
    for template in _template_definitions():
        component_names = tuple(item["assetId"] for item in template["components"])
        if any(name not in assets for name in component_names):
            raise ValueError("CANDIDATE_COMPONENT_MISSING")
        if any(assets[name]["classification"] != "pure-indicator" for name in component_names):
            raise ValueError("CANDIDATE_COMPONENT_NOT_INDICATOR")
        source_digests = {name: _source_digest(assets[name]) for name in component_names}
        common_lifecycle = {
            "flatEntry": "evaluate every eligible closed bar",
            "longSupported": True,
            "shortSupported": True,
            "exit": "explicit exit rule, protective stop, take-profit, or window end",
            "reversal": "opposite entry signal closes then reverses at the same next open",
        }
        common_risk = {
            "stopLoss": "ATR multiple fixed when the entry order is created",
            "takeProfit": "entry stop distance multiplied by rewardRisk",
            "stopFirstWhenBothTouched": True,
            "maxHoldingBarsParameter": "max_holding_bars",
        }
        identity_body = {
            "label": SPEC_LABEL,
            "template": template["name"],
            "version": "1.0.0",
            "components": template["components"],
            "entryRules": template["entry"],
            "exitRules": template["exit"],
            "positionLifecycle": common_lifecycle,
            "riskRules": common_risk,
            "timeframe": ["5m", "4h"],
            "symbols": ["ADA/USDT", "BNB/USDT", "BTC/USDT", "DOGE/USDT", "DOT/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT"],
            "parameters": {"selectionPolicy": "explicit-enumeration-only", "candidateSets": list(template["parameterSets"])},
            "warmupBars": template["warmup"],
            "executionTiming": SUPPORTED_EXECUTION_TIMING,
            "costModel": {"feeBps": 4.0, "slippageBps": 1.0, "stressFeeBps": 8.0, "stressSlippageBps": 3.0},
            "sourceAssetDigests": source_digests,
        }
        strategy_id = f"derived-{template['name']}-{canonical_sha256(identity_body)[:16]}"
        spec = StrategySpec(
            strategy_id=strategy_id,
            version="1.0.0",
            components=tuple(template["components"]),
            entry_rules=tuple(template["entry"]),
            exit_rules=tuple(template["exit"]),
            position_lifecycle=common_lifecycle,
            risk_rules=common_risk,
            timeframe=("5m", "4h"),
            symbols=("ADA/USDT", "BNB/USDT", "BTC/USDT", "DOGE/USDT", "DOT/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT"),
            parameters={"selectionPolicy": "explicit-enumeration-only", "candidateSets": list(template["parameterSets"])},
            warmup_bars=int(template["warmup"]),
            execution_timing=SUPPORTED_EXECUTION_TIMING,
            cost_model={"feeBps": 4.0, "slippageBps": 1.0, "stressFeeBps": 8.0, "stressSlippageBps": 3.0},
            source_asset_digests=source_digests,
        )
        validate_strategy_spec(spec)
        specs.append(spec)
    if len(specs) != 4 or len({item.strategy_id for item in specs}) != 4:
        raise ValueError("CANDIDATE_FACTORY_CARDINALITY_INVALID")
    return tuple(specs)


def validate_strategy_spec(spec: StrategySpec) -> None:
    payload = spec.to_dict()
    if payload["label"] != SPEC_LABEL or not spec.strategy_id.startswith("derived-"):
        raise ValueError("STRATEGY_SPEC_LABEL_INVALID")
    if spec.execution_timing != SUPPORTED_EXECUTION_TIMING:
        raise ValueError("STRATEGY_SPEC_EXECUTION_INVALID")
    if spec.warmup_bars < 2 or not spec.components or not spec.entry_rules or not spec.exit_rules:
        raise ValueError("STRATEGY_SPEC_INCOMPLETE")
    if not spec.position_lifecycle.get("flatEntry") or not spec.position_lifecycle.get("reversal"):
        raise ValueError("STRATEGY_SPEC_LIFECYCLE_INVALID")
    if not spec.risk_rules.get("stopLoss") or not spec.risk_rules.get("takeProfit"):
        raise ValueError("STRATEGY_SPEC_RISK_INVALID")
    if not spec.timeframe or not spec.symbols:
        raise ValueError("STRATEGY_SPEC_UNIVERSE_INVALID")
    candidate_sets = spec.parameters.get("candidateSets")
    if spec.parameters.get("selectionPolicy") != "explicit-enumeration-only" or not isinstance(candidate_sets, list) or not (1 <= len(candidate_sets) <= 3):
        raise ValueError("STRATEGY_SPEC_PARAMETERS_INVALID")
    for component, digests in spec.source_asset_digests.items():
        if component not in {item["assetId"] for item in spec.components} or any(not _SHA256.fullmatch(value) for value in digests.values()):
            raise ValueError("STRATEGY_SPEC_SOURCE_DIGEST_INVALID")


_CALCULATORS: dict[str, Callable[[pd.DataFrame, dict[str, Any]], dict[str, Any]]] = {
    "TrendImpulse": trend_impulse,
    "StochasticOverlay": stochastic,
    "STC": stc,
    "MeanReversion": mean_reversion,
    "SRRange": sr_range,
}


def _component_series(component_id: str, bars: pd.DataFrame, params: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Vectorized causal outputs equivalent to calling the component per prefix."""
    close, high, low = bars["close"].astype(float), bars["high"].astype(float), bars["low"].astype(float)
    count = len(bars)
    if component_id == "TrendImpulse":
        period, multiplier = int(params["period"]), float(params["mult"])
        true_range = pd.concat((high - low, (high - close.shift(1)).abs(), (low - close.shift(1)).abs()), axis=1).max(axis=1)
        middle = close.rolling(period, min_periods=period).mean()
        atr = true_range.rolling(period).mean()
        upper, lower = middle + multiplier * atr, middle - multiplier * atr
        outputs = []
        for index in range(count):
            latest = float(close.iloc[index])
            u = latest if pd.isna(upper.iloc[index]) else float(upper.iloc[index])
            l = latest if pd.isna(lower.iloc[index]) else float(lower.iloc[index])
            m = latest if pd.isna(middle.iloc[index]) else float(middle.iloc[index])
            signal = "BEAR" if latest > u else ("BULL" if latest < l or latest > m else "BEAR")
            outputs.append({"name": "TrendImpulse", "signal": signal})
        return outputs
    if component_id == "StochasticOverlay":
        k_period, d_period = int(params["k"]), int(params["d"])
        lowest, highest = low.rolling(k_period).min(), high.rolling(k_period).max()
        k_line = (close - lowest) / (highest - lowest).replace(0, np.nan) * 100.0
        d_line = k_line.rolling(d_period, min_periods=1).mean()
        outputs = []
        for index in range(count):
            k = 50.0 if pd.isna(k_line.iloc[index]) else float(k_line.iloc[index])
            d = 50.0 if pd.isna(d_line.iloc[index]) else float(d_line.iloc[index])
            signal = ("SELL" if k < d else "WATCH") if k > 80 else (("BUY" if k > d else "WATCH") if k < 20 else "HOLD")
            outputs.append({"name": "StochasticOverlay", "signal": signal})
        return outputs
    if component_id == "STC":
        fast, slow, cycle = int(params["fast"]), int(params["slow"]), int(params["cycle"])
        d1, d2 = int(params["d1"]), int(params["d2"])
        macd = close.ewm(span=fast, adjust=False).mean() - close.ewm(span=slow, adjust=False).mean()
        lowest, highest = macd.rolling(cycle, min_periods=cycle).min(), macd.rolling(cycle, min_periods=cycle).max()
        raw = (macd - lowest) / (highest - lowest).replace(0, np.nan) * 100.0
        raw = raw.where(highest != lowest, 50.0)
        final = raw.rolling(d1, min_periods=1).mean().rolling(d2, min_periods=1).mean()
        outputs = []
        for index in range(count):
            latest = 50.0 if pd.isna(final.iloc[index]) else float(final.iloc[index])
            previous = latest if index == 0 or pd.isna(final.iloc[index - 1]) else float(final.iloc[index - 1])
            signal = "BUY" if previous <= 25 < latest else ("SELL" if previous >= 75 > latest else "HOLD")
            outputs.append({"name": "STC", "signal": signal, "trend": "BULL" if latest > 50 else "BEAR"})
        return outputs
    if component_id == "MeanReversion":
        period = int(params["period"])
        rolling_mean = close.rolling(period, min_periods=period).mean()
        rolling_std = close.rolling(period, min_periods=period).std(ddof=0)
        z_score = (close - rolling_mean) / rolling_std.replace(0, np.nan)
        probability = 0.5 * (1.0 + np.tanh(z_score / np.sqrt(2.0 / np.pi)))
        outputs = []
        for index in range(count):
            value = 0.5 if pd.isna(probability.iloc[index]) else float(probability.iloc[index])
            signal = "BUY" if value < 0.15 else ("SELL" if value > 0.85 else "HOLD")
            outputs.append({"name": "MeanReversion", "signal": signal, "probability": round(value, 4)})
        return outputs
    if component_id == "SRRange":
        left, right = int(params["swing_left"]), int(params["swing_right"])
        true_range = pd.concat((high - low, (high - close.shift(1)).abs(), (low - close.shift(1)).abs()), axis=1).max(axis=1)
        atr_series = true_range.rolling(14, min_periods=1).mean()
        last_high: int | None = None
        last_low: int | None = None
        outputs = []
        for index in range(count):
            pivot = index - right
            if pivot >= left:
                high_window = high.iloc[pivot - left: pivot + right + 1]
                low_window = low.iloc[pivot - left: pivot + right + 1]
                if float(high.iloc[pivot]) == float(high_window.max()):
                    last_high = pivot
                if float(low.iloc[pivot]) == float(low_window.min()):
                    last_low = pivot
            latest, atr = float(close.iloc[index]), float(atr_series.iloc[index])
            resistance = float(high.iloc[last_high]) if last_high is not None else latest + atr * 2
            support = float(low.iloc[last_low]) if last_low is not None else latest - atr * 2
            midpoint = (resistance + support) / 2
            position = "LONG" if latest < support + atr * 0.5 else ("SHORT" if latest > resistance - atr * 0.5 else "HOLD")
            outputs.append({"name": "SRRange", "position": position, "signal": "BULLISH" if latest > midpoint else "BEARISH"})
        return outputs
    raise ValueError(f"STRATEGY_COMPONENT_UNSUPPORTED:{component_id}")


def _compare(actual: Any, operator: str, expected: Any) -> bool:
    if operator == "eq":
        return actual == expected
    if operator == "gte":
        return float(actual) >= float(expected)
    if operator == "lte":
        return float(actual) <= float(expected)
    raise ValueError(f"STRATEGY_RULE_OPERATOR_INVALID:{operator}")


class CompiledStrategyAdapter:
    """Interpreter for a canonical StrategySpec using closed history only."""

    def __init__(self, spec: StrategySpec):
        validate_strategy_spec(spec)
        self.spec = spec
        self.strategy_id = spec.strategy_id
        self.version = spec.version
        self.minimum_history = spec.warmup_bars
        self.history_limit = spec.warmup_bars + 5
        self._output_cache: dict[tuple[str, str], dict[str, Any]] = {}

    def prime(self, bars: pd.DataFrame, parameters: Mapping[str, Any]) -> None:
        """Populate causal component outputs for each timestamp without future access."""
        parameter_key = canonical_sha256(parameters)
        component_outputs: dict[str, list[dict[str, Any]]] = {}
        for component in self.spec.components:
            component_id = str(component["assetId"])
            mapped = {target: parameters[source] for target, source in component["parameterMap"].items()}
            component_outputs[component_id] = _component_series(component_id, bars, mapped)
        for index in range(len(bars)):
            timestamp = pd.Timestamp(bars.iloc[index]["date"]).isoformat()
            self._output_cache[(parameter_key, timestamp)] = {component_id: outputs[index] for component_id, outputs in component_outputs.items()}

    def _outputs(self, history: pd.DataFrame, parameters: Mapping[str, Any]) -> dict[str, Any]:
        timestamp = pd.Timestamp(history.iloc[-1]["date"]).isoformat()
        cache_key = (canonical_sha256(parameters), timestamp)
        cached = self._output_cache.get(cache_key)
        if cached is not None:
            return cached
        result: dict[str, Any] = {}
        bounded = history.tail(self.minimum_history + 5).copy(deep=True)
        for component in self.spec.components:
            component_id = str(component["assetId"])
            mapped = {target: parameters[source] for target, source in component["parameterMap"].items()}
            output = _CALCULATORS[component_id](bounded, mapped)
            if "error" in output:
                return {}
            result[component_id] = output
        self._output_cache[cache_key] = result
        return result

    @staticmethod
    def _matches(rule: Mapping[str, Any], outputs: Mapping[str, Any]) -> bool:
        mode = "all" if "all" in rule else "any"
        clauses = rule[mode]
        checks = []
        for clause in clauses:
            component = outputs.get(clause["component"], {})
            checks.append(_compare(component.get(clause["field"]), clause["operator"], clause["value"]))
        return all(checks) if mode == "all" else any(checks)

    def _entry(self, side: str, outputs: Mapping[str, Any]) -> bool:
        return any(rule.get("side") == side and self._matches(rule, outputs) for rule in self.spec.entry_rules)

    def _exit(self, side: str, outputs: Mapping[str, Any]) -> bool:
        return any(rule.get("position") == side and self._matches(rule, outputs) for rule in self.spec.exit_rules)

    @staticmethod
    def _atr(history: pd.DataFrame, period: int) -> float:
        previous = history["close"].shift(1)
        true_range = pd.concat((history["high"] - history["low"], (history["high"] - previous).abs(), (history["low"] - previous).abs()), axis=1).max(axis=1)
        return float(true_range.tail(period).mean())

    def decide(self, history: pd.DataFrame, parameters: Mapping[str, Any], context: StrategyContext) -> Action | Decision:
        allowed = {canonical_json(item) for item in self.spec.parameters["candidateSets"]}
        if canonical_json(dict(parameters)) not in allowed:
            raise ValueError("STRATEGY_PARAMETERS_NOT_DECLARED")
        outputs = self._outputs(history, parameters)
        if not outputs:
            return Action.HOLD
        long_entry = self._entry("long", outputs)
        short_entry = self._entry("short", outputs)
        if long_entry and short_entry:
            return Action.HOLD
        max_holding = int(parameters["max_holding_bars"])
        if context.position == 1:
            if short_entry:
                return self._entry_decision(Action.ENTER_SHORT, history, parameters)
            return Action.EXIT if self._exit("long", outputs) or context.bars_held >= max_holding else Action.HOLD
        if context.position == -1:
            if long_entry:
                return self._entry_decision(Action.ENTER_LONG, history, parameters)
            return Action.EXIT if self._exit("short", outputs) or context.bars_held >= max_holding else Action.HOLD
        if long_entry:
            return self._entry_decision(Action.ENTER_LONG, history, parameters)
        if short_entry:
            return self._entry_decision(Action.ENTER_SHORT, history, parameters)
        return Action.HOLD

    def _entry_decision(self, action: Action, history: pd.DataFrame, parameters: Mapping[str, Any]) -> Decision:
        stop = self._atr(history, int(parameters["atr_period"])) * float(parameters["stop_atr"])
        if not stop > 0:
            return Decision(Action.HOLD)
        return Decision(action, stop_distance=stop, take_profit_distance=stop * float(parameters["reward_risk"]))


def candidate_parameter_sets(spec: StrategySpec) -> tuple[dict[str, Any], ...]:
    return tuple(json.loads(json.dumps(item, sort_keys=True)) for item in spec.parameters["candidateSets"])


def build_candidate_manifest(asset_manifest: Mapping[str, Any], source_commit: str) -> dict[str, Any]:
    specs = build_candidate_specs(asset_manifest)
    payload: dict[str, Any] = {
        "schemaVersion": "stage-4a12.candidate-manifest.v1",
        "labels": [SPEC_LABEL, "BOUNDED EXPLICIT CANDIDATE SET", "NOT APPROVED FOR PAPER, TESTNET OR LIVE"],
        "sourceCommit": source_commit,
        "sourceAssetProofId": asset_manifest["proofId"],
        "sourceAssetCounts": dict(asset_manifest["counts"]),
        "blockedLifecycleAssetsRemainBlocked": True,
        "tradeIqHoldoutExcludedFromCandidateSelection": True,
        "candidateCount": len(specs),
        "specs": [item.to_dict() for item in specs],
    }
    payload["manifestId"] = canonical_sha256(payload)
    return payload


def verify_candidate_manifest(asset_manifest: Mapping[str, Any], manifest: Mapping[str, Any], source_commit: str) -> None:
    expected = build_candidate_manifest(asset_manifest, source_commit)
    if expected != manifest:
        raise ValueError("CANDIDATE_MANIFEST_RECOMPUTATION_MISMATCH")
    if manifest.get("candidateCount") != 4 or manifest.get("sourceAssetCounts", {}).get("needsLifecycle") != 4:
        raise ValueError("CANDIDATE_MANIFEST_COUNTS_INVALID")
