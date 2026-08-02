"""
quant_engine/indicators/__init__.py
P0 + P1 + P2 + P3 指标注册入口
Phase 4 收尾: 注册 Indicator 13 CompositeMomentum + Indicator 14 SmartOrderBlock
"""
from typing import Dict, Any

# ─── P0: daemon.py 内置 ──────────────────────────────────────────────────────

# ─── P1: 基础指标（4个） ─────────────────────────────────────────────────────
from quant_engine.indicators.stc import calculate as calc_stc
from quant_engine.indicators.stochastic import calculate as calc_stochastic
from quant_engine.indicators.mean_reversion import calculate as calc_mean_reversion
from quant_engine.indicators.trend_impulse import calculate as calc_trend_impulse

calc_stochastic_overlay = calc_stochastic

P1_INDICATORS: Dict[str, Any] = {
    "STC": calc_stc,
    "StochasticOverlay": calc_stochastic_overlay,
    "MeanReversion": calc_mean_reversion,
    "TrendImpulse": calc_trend_impulse,
}

# ─── P2: 高阶指标（4个 + VP Tick回归1个，共5个） ──────────────────────────
from quant_engine.indicators.elliott_wave import calculate as calc_elliott_wave
from quant_engine.indicators.fibonacci import calculate as calc_fibonacci
from quant_engine.indicators.sr_range import calculate as calc_sr_range
from quant_engine.indicators.deltaflow import calculate as calc_deltaflow
from quant_engine.indicators.volume_profile import calculate as calc_volume_profile

P2_INDICATORS: Dict[str, Any] = {
    "ElliottWave": calc_elliott_wave,
    "FibonacciEntryBands": calc_fibonacci,
    "SRRange": calc_sr_range,
    "DeltaFlow": calc_deltaflow,
    "VolumeProfile": calc_volume_profile,
}

# ─── P3: 复合智能指标（2个） — Phase 4 闭环 ───────────────────────────────
from quant_engine.indicators.composite_momentum import calculate as calc_composite_momentum
from quant_engine.indicators.smart_order_block import calculate as calc_smart_order_block

P3_INDICATORS: Dict[str, Any] = {
    "CompositeMomentum": calc_composite_momentum,
    "SmartOrderBlock": calc_smart_order_block,
}

# ─── P4: 论文方法 (arXiv 2607.22491 Regime Gate) ────────────────────────────
from quant_engine.indicators.regime_gate import calculate as calc_regime_gate

P4_INDICATORS: Dict[str, Any] = {
    "RegimeGate": calc_regime_gate,
}
