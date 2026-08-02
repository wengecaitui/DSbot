"""
quant_engine/daemon.py
Hermes Python Compute Layer — 常驻进程
Phase 4.2: P0 黄金首发指标 (Hull Suite / Chandelier Exit / UT Bot Alerts)
Phase 4.3: 增加 JSON Schema 协议校验

协议: JSON Lines over stdin/stdout
  TS → Python:  {"type":"CALC","correlationId":"abc123","asset":"BTC/USDT","series":[...],"indicators":[{"name":"HMA","params":{...}}]}
  Python → TS: {"type":"CALC_RES","correlationId":"abc123","status":"SUCCESS","data":{...}}
"""

import sys
import os
import os.path as _path
_sys_path_anchor = _path.dirname(_path.abspath(__file__))
if _sys_path_anchor not in sys.path:
    sys.path.insert(0, _sys_path_anchor)

_sys_path_parent = os.path.dirname(_sys_path_anchor)
if _sys_path_parent not in sys.path:
    sys.path.insert(0, _sys_path_parent)

import os
import json
import traceback
import pandas as pd
import numpy as np
import jsonschema
from typing import Any, Dict, List

# ─── 管道安全：重定向 print 到空设备，仅通过 sys.__stdout__ 回吐 JSON ───────
try:
    sys.stdout = open(os.devnull, "w")
except Exception:
    pass

# ─── 协议 Schema 加载 ──────────────────────────────────────────────────────
SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "protocol-schema.json")
PROTOCOL_SCHEMA: Dict[str, Any] = {}
if os.path.exists(SCHEMA_PATH):
    with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
        PROTOCOL_SCHEMA = json.load(f)


def validate_request(packet: Dict) -> None:
    """使用 JSON Schema 校验请求结构"""
    if not PROTOCOL_SCHEMA:
        return
    msg_type = packet.get("type")
    if msg_type not in PROTOCOL_SCHEMA.get("message_types", {}):
        # 在外部已有类型检查，这里只做静默跳过
        return
    schema = PROTOCOL_SCHEMA["message_types"][msg_type].get("request")
    if schema:
        jsonschema.validate(instance=packet, schema=schema)


# ─── 工具函数 ───────────────────────────────────────────────────────────────

def _to_df(series: List[Dict]) -> pd.DataFrame:
    """将 TS 传的 OHLCV 列表转为 DataFrame，确保列名统一"""
    df = pd.DataFrame(series)
    df.columns = [c.lower() for c in df.columns]
    for col in ("open", "high", "low", "close", "volume"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def _wma(series: pd.Series, period: int) -> pd.Series:
    """加权移动平均"""
    weights = np.arange(1, period + 1)
    def wma_window(x):
        if len(x) < period:
            return np.nan
        return np.dot(x, weights) / weights.sum()
    return series.rolling(period).apply(wma_window, raw=True)


def _ema(series: pd.Series, period: int) -> pd.Series:
    """指数移动平均"""
    return series.ewm(span=period, adjust=False).mean()


def _atr(df: pd.DataFrame, period: int) -> pd.Series:
    """平均真实波幅"""
    high = df["high"]
    low = df["low"]
    close = df["close"]
    tr = pd.concat([
        high - low,
        (high - close.shift(1)).abs(),
        (low - close.shift(1)).abs()
    ], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def _rsi(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """相对强弱指标"""
    delta = df["close"].diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)
    avg_gain = _ema(gain, period)
    avg_loss = _ema(loss, period)
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def _macd(df: pd.DataFrame, fast: int = 12, slow: int = 26, signal: int = 9) -> Dict[str, pd.Series]:
    """MACD 指标"""
    ema_fast = _ema(df["close"], fast)
    ema_slow = _ema(df["close"], slow)
    macd_line = ema_fast - ema_slow
    signal_line = _ema(macd_line, signal)
    histogram = macd_line - signal_line
    return {"macd": macd_line, "signal": signal_line, "histogram": histogram}


# ─── P0 指标：黄金首发阵容 ───────────────────────────────────────────────────

def calc_hull_suite(df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
    """
    Hull Suite (HMA — Hull Moving Average)
    作者: InSilico | 批次: P0 | 难度: 🟢
    """
    period = int(params.get("period", 200))
    if len(df) < period + 5:
        return {"error": f"数据不足，需要 {period + 5} 根 K 线"}

    close = df["close"]
    sqrt_p = int(np.ceil(np.sqrt(period)))
    half_p = int(period / 2)

    wma1 = _wma(close, half_p)
    wma2 = _wma(close, period)
    hull_raw = 2 * wma1 - wma2
    hma = _wma(hull_raw.dropna(), sqrt_p)

    hma = hma.reindex(df.index)
    latest_close = float(close.iloc[-1])
    latest_hma = float(hma.iloc[-1]) if not np.isnan(hma.iloc[-1]) else latest_close

    if len(hma.dropna()) >= 2:
        prev_hma = float(hma.iloc[-2])
        trend = "BULL" if latest_hma > prev_hma else "BEAR"
    else:
        trend = "NEUTRAL"

    return {
        "name": "HullSuite",
        "period": period,
        "hma": round(latest_hma, 4),
        "close": latest_close,
        "trend": trend,
        "position": "LONG" if trend == "BULL" else ("SHORT" if trend == "BEAR" else "HOLD"),
        "lag_bars": 0
    }


def calc_chandelier_exit(df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
    """
    Chandelier Exit (吊灯止损)
    作者: everget | 批次: P0 | 难度: 🟢
    """
    length = int(params.get("length", 22))
    mult = float(params.get("mult", 3.0))
    use_close = bool(params.get("useClose", True))

    if len(df) < length + 2:
        return {"error": f"数据不足，需要 {length + 2} 根 K 线"}

    atr = _atr(df, length)
    highest = df["close"] if use_close else df["high"]
    lowest = df["low"]

    long_stop = highest.rolling(length).max() - mult * atr
    short_stop = lowest.rolling(length).min() + mult * atr

    long_stop_prev = long_stop.shift(1).fillna(long_stop)
    short_stop_prev = short_stop.shift(1).fillna(short_stop)

    dir_series = pd.Series(1, index=df.index)
    dir_series = np.where(df["close"] > short_stop_prev, 1,
                          np.where(df["close"] < long_stop_prev, -1, dir_series))

    latest_dir = int(dir_series[-1])
    prev_dir = int(dir_series[-2]) if len(dir_series) >= 2 else latest_dir

    signal = "HOLD"
    if latest_dir == 1 and prev_dir == -1:
        signal = "LONG"
    elif latest_dir == -1 and prev_dir == 1:
        signal = "SHORT"

    return {
        "name": "ChandelierExit",
        "length": length,
        "mult": mult,
        "long_stop": round(float(long_stop.iloc[-1]), 4),
        "short_stop": round(float(short_stop.iloc[-1]), 4),
        "direction": "LONG" if latest_dir == 1 else "SHORT",
        "signal": signal,
        "atr": round(float(atr.iloc[-1]), 4),
        "lag_bars": 0
    }


def calc_ut_bot_alerts(df: pd.DataFrame, params: Dict) -> Dict[str, Any]:
    """
    UT Bot Alerts
    作者: QuantNomad | 批次: P0 | 难度: 🟢
    """
    key_value = float(params.get("keyPass", 1.0))
    atr_period = int(params.get("atrPeriod", 10))

    if len(df) < atr_period + 5:
        return {"error": f"数据不足，需要 {atr_period + 5} 根 K 线"}

    atr = _atr(df, atr_period)
    close = df["close"]

    trailing_stop = close.copy()
    for i in range(1, len(close)):
        prev_stop = trailing_stop.iloc[i - 1]
        curr_close = close.iloc[i]
        curr_atr = atr.iloc[i]

        if curr_close > prev_stop and close.iloc[i - 1] > prev_stop:
            new_stop = max(prev_stop, curr_close - key_value * curr_atr)
        elif curr_close < prev_stop and close.iloc[i - 1] < prev_stop:
            new_stop = min(prev_stop, curr_close + key_value * curr_atr)
        else:
            new_stop = curr_close - key_value * curr_atr if curr_close > prev_stop else curr_close + key_value * curr_atr
        trailing_stop.iloc[i] = new_stop

    prev_close = close.iloc[-2]
    curr_close = close.iloc[-1]
    prev_stop = trailing_stop.iloc[-2]
    curr_stop = trailing_stop.iloc[-1]

    buy_signal = bool(prev_close < prev_stop and curr_close > curr_stop)
    sell_signal = bool(prev_close > prev_stop and curr_close < curr_stop)

    return {
        "name": "UTBotAlerts",
        "keyPass": key_value,
        "atrPeriod": atr_period,
        "trailingStop": round(float(curr_stop), 4),
        "close": round(float(curr_close), 4),
        "buy": buy_signal,
        "sell": sell_signal,
        "signal": "BUY" if buy_signal else ("SELL" if sell_signal else "HOLD"),
        "lag_bars": 0
    }


# ─── P0 指标分发器 ──────────────────────────────────────────────────────────

P0_INDICATORS = {
    "HullSuite": calc_hull_suite,
    "ChandelierExit": calc_chandelier_exit,
    "UTBotAlerts": calc_ut_bot_alerts,
}

# 导入 P1 + P2 + P3 + P4
from quant_engine.indicators import P1_INDICATORS, P2_INDICATORS, P3_INDICATORS, P4_INDICATORS

# 合并 P0 + P1 + P2 + P3 + P4 指标生成完整分发器
INDICATOR_DISPATCH = {}
INDICATOR_DISPATCH.update(P0_INDICATORS)
INDICATOR_DISPATCH.update(P1_INDICATORS)
INDICATOR_DISPATCH.update(P2_INDICATORS)
INDICATOR_DISPATCH.update(P3_INDICATORS)
INDICATOR_DISPATCH.update(P4_INDICATORS)


# ─── PING/PONG 握手 ─────────────────────────────────────────────────────────

def handle_ping(cid: str) -> Dict:
    return {"type": "PONG", "correlationId": cid, "status": "READY"}


# ─── 主循环 ────────────────────────────────────────────────────────────────

def main():
    # ─── 命令行参数解析（支持 --self-test）─────────────────────────────────────
    if "--self-test" in sys.argv or "--selftest" in sys.argv:
        from quant_engine.daemon_selftest import run_self_test
        sys.exit(run_self_test())
    
    if "--ping" in sys.argv:
        # 简单 ping 模式：只发 PONG 就退出
        write_response({"type": "PONG", "correlationId": "cli-ping", "status": "READY"})
        return
    
    # 启动时主动发送 PONG，让 TS 端知道 daemon 已就绪
    try:
        write_response({"type": "PONG", "correlationId": "boot", "status": "READY"})
    except Exception:
        pass

    while True:
        try:
            raw = sys.__stdin__.readline()
            if not raw:
                break

            line = raw.strip()
            if not line:
                continue

            packet = json.loads(line)
            cmd_type = packet.get("type")
            cid = packet.get("correlationId")
            
            # 命令类型合法性检查（在协议校验前，避免 ValueError 变成 FATAL）
            if cmd_type not in ("PING", "CALC"):
                write_response({
                    "type": "ERROR",
                    "correlationId": cid,
                    "status": "UNKNOWN",
                    "error": f"未知命令类型: {cmd_type}",
                })
                continue

            # 协议校验（JSON Schema）
            try:
                validate_request(packet)
            except jsonschema.ValidationError as e:
                write_response({
                    "type": "ERROR",
                    "correlationId": cid,
                    "status": "PARSE_ERR",
                    "error": f"协议校验失败: {e.message}"
                })
                continue

            if cmd_type == "PING":
                write_response(handle_ping(cid))
                continue

            if cmd_type == "CALC":
                try:
                    result = handle_calc(packet)
                    write_response({
                        "type": "CALC_RES",
                        "correlationId": cid,
                        "status": "SUCCESS",
                        "asset": packet.get("asset"),
                        "data": result
                    })
                except Exception as calc_err:
                    write_response({
                        "type": "ERROR",
                        "correlationId": cid,
                        "status": "FAILED",
                        "error": str(calc_err),
                        "traceback": traceback.format_exc()
                    })
                continue

            write_response({
                "type": "ERROR",
                "correlationId": cid,
                "status": "UNKNOWN",
                "error": f"未知命令类型: {cmd_type}"
            })

        except json.JSONDecodeError as e:
            write_response({"type": "ERROR", "correlationId": None, "status": "PARSE_ERR", "error": str(e)})
        except Exception as e:
            write_response({"type": "ERROR", "correlationId": None, "status": "FATAL", "error": str(e), "traceback": traceback.format_exc()})


def write_response(payload: Dict):
    """向 TS 管道写入单行 JSON（通过 sys.__stdout__）"""
    try:
        raw = json.dumps(payload, ensure_ascii=False)
        sys.__stdout__.write(raw + "\n")
        sys.__stdout__.flush()
    except Exception:
        pass


def _with_authoritative_name(name: str, result: Any) -> Any:
    """Attach the dispatch key to mapping results without mutating indicator state."""
    if not isinstance(result, dict):
        return result
    return {**result, "name": name}


def handle_calc(packet: Dict) -> Dict[str, Any]:
    """处理 CALC 请求，路由到对应指标"""
    asset = packet.get("asset", "UNKNOWN")
    series = packet.get("series", [])
    indicators = packet.get("indicators", [])
    ticks = packet.get("ticks", [])  # Phase 5: Tick 逐笔数据

    if not series:
        raise ValueError("series 数据为空")
    if not indicators:
        raise ValueError("indicators 列表为空")

    df = _to_df(series)
    results: Dict[str, Any] = {}

    for ind in indicators:
        name = ind.get("name", "")
        params = ind.get("params", {})

        # Phase 5: 传入 ticks 参数（仅 VolumeProfile 使用精确版）
        if ticks and name == "VolumeProfile":
            params["ticks"] = ticks

        if name in INDICATOR_DISPATCH:
            result = INDICATOR_DISPATCH[name](df, params)
            results[name] = _with_authoritative_name(name, result)
        else:
            results[name] = _with_authoritative_name(
                name,
                {"error": f"指标 {name} 未实现"},
            )

    return results


if __name__ == "__main__":
    main()
