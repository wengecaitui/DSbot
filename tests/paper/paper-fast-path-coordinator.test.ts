// Stage 3B4C15-R2
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PaperFastPathCoordinator } from '../../src/paper/PaperFastPathCoordinator';
import { PaperExecutionService } from '../../src/paper/PaperExecutionService';
import { PaperLedgerStore } from '../../src/paper/PaperLedgerStore';
import { FastPipeline } from '../../src/pipeline/FastPipeline';
import { KillSwitch } from '../../src/router/KillSwitch';
import { createMarketSnapshotStore } from '../../src/data/MarketSnapshotStore';
import { createCandleSeriesStore } from '../../src/data/CandleSeriesStore';
import type { ExchangeId } from '../../src/data/MarketIdentity';
import type { PaperAccountConfig } from '../../src/types/paper-account';

const EXCH: ExchangeId = 'bitget';
const an: PaperAccountConfig = { accountId: 's15r2', exchange: EXCH, initialCashUsd: 100_000 };
const SYM = 'BTCUSDT';

function mkTicker(exchange: ExchangeId, instId: string, last: number, ts: number) {
  return { exchange, instId, channel: 'ticker' as const, last, bestBid: last - 1, bestAsk: last + 1, volume24h: 1000, high24h: last * 1.02, low24h: last * 0.98, ts };
}
function mkKline(exchange: ExchangeId, instId: string, close: number, ts: number) {
  return { exchange, instId, channel: 'kline' as const, interval: '1m', open: close * 0.999, high: close * 1.001, low: close * 0.998, close, volume: 100, ts, confirm: true };
}
function momentumResult() {
  return { name: 'CompositeMomentum' as const, composite_score: 85, regime_state: 'STRONG_BULLISH' as const, in_cooldown: false, dimension_scores: { hull_big_trend: { value: 1, weight: 1 }, stc_momentum: { value: 1, weight: 1 }, volume_micro: { value: 1, weight: 1 } }, lag_bars: 0, elapsedMs: 0 };
}

const TEST_NOW = 1_900_000_000_000;
const testClock = { now: () => TEST_NOW };

function buildFp(overrides?: { staleAfterMs?: number }) {
  const future = TEST_NOW;
  const store = createMarketSnapshotStore({ staleAfterMs: overrides?.staleAfterMs ?? 60_000, clock: testClock });
  const candle = createCandleSeriesStore({ capacityPerSeries: 500 });
  store.updateTicker({ ticker: mkTicker(EXCH, SYM, 50000, future), receivedAt: future });
  for (let i = 0; i < 200; i++) {
    const k = mkKline(EXCH, SYM, 49000 + i * 10, future - (200 - i) * 60_000);
    store.updateClosedKline({ kline: k, receivedAt: k.ts });
    candle.appendClosedKline({ kline: k, receivedAt: k.ts });
  }
  const ks = new KillSwitch(EXCH, { totalCapitalUsd: 100_000, maxPositionPct: 1, maxSinglePositionPct: 1, allowConcentration: true });
  const fp = new FastPipeline({
    exchange: EXCH,
    router: { exchange: EXCH, getBiasReport: () => ({ exchange: EXCH, updatedAt: TEST_NOW, assets: [{ symbol: SYM, direction: 'long' as const, confidence: 85, suggestedPositionPct: 0.1 }], whitelist: [SYM] }), getConfig: () => ({ maxBiasReportAgeHours: 24 }), killSwitch: ks },
    indicatorService: { calculateAll: async () => [momentumResult()] },
    marketData: { exchange: EXCH, snapshotStore: store, candleStore: candle, interval: '1m', minimumSeries: 100, seriesLimit: 200 },
    clock: testClock,
  });
  return { fp, store, candle };
}
async function svc(d: string) { return PaperExecutionService.open(an, new PaperLedgerStore(an, { baseDir: d })); }
const SIG = { exchange: EXCH, symbol: SYM, source: 's' };
const P = { feeBps: 10, slippageBps: 5 };

test('1. trade → quote=snapshot ticks, paper applied, fills=1', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r2-')); try {
    const { fp, store } = buildFp(); const s = await svc(d);
    const r = await new PaperFastPathCoordinator(fp, s, EXCH).run(SIG, P);
    assert.equal(r.pipelineResult.decision, 'trade');
    assert.ok(r.pipelineResult.tradeIntent);
    assert.equal(r.paperEvent!.status, 'applied');
    assert.equal(s.snapshot().processedFills, 1);
    const quote = r.pipelineResult.executionQuote!;
    const snap = store.getSnapshot(EXCH, SYM)!;
    assert.equal(quote.exchange, snap.exchange);
    assert.equal(quote.symbol, snap.symbol);
    assert.equal(quote.markPriceUsd, snap.ticker!.ticker.last);
    assert.equal(quote.executedAtMs, snap.ticker!.ticker.ts);
    assert.equal(quote.snapshotVersion, snap.snapshotVersion);
    // executedAtMs flows into fill identity via fillId; event doesn't expose it
    assert.ok(r.paperEvent!.fillId, 'fillId must exist');
    assert.ok(/^sim-[a-f0-9]{32}$/.test(r.paperEvent!.fillId!));
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('2. skip whitelist: decision=skip, no paper, fills=0', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r2-')); try {
    const { fp } = buildFp(); const s = await svc(d);
    const r = await new PaperFastPathCoordinator(fp, s, EXCH).run({ exchange: EXCH, symbol: 'ETHUSDT', source: 's' }, P);
    assert.equal(r.pipelineResult.decision, 'skip');
    assert.equal(r.paperEvent, undefined);
    assert.equal(s.snapshot().processedFills, 0);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('3. exchange mismatch: rejects, fills=0', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r2-')); try {
    const { fp } = buildFp(); const s = await svc(d);
    await assert.rejects(() => new PaperFastPathCoordinator(fp, s, EXCH).run({ exchange: 'binance' as ExchangeId, symbol: SYM, source: 's' }, P));
    assert.equal(s.snapshot().processedFills, 0);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('4. invalid fee: rejects, fills=0', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r2-')); try {
    const { fp } = buildFp(); const s = await svc(d);
    await assert.rejects(() => new PaperFastPathCoordinator(fp, s, EXCH).run(SIG, { feeBps: -1, slippageBps: 5 }));
    assert.equal(s.snapshot().processedFills, 0);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('5. coordinator rejects invalid exchange', () => {
  assert.throws(() => new PaperFastPathCoordinator(null as unknown as FastPipeline, null as unknown as PaperExecutionService, 'bad' as ExchangeId), /exchange/);
});

test('6. stale snapshot: defense, no quote, no paper, fills=0', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r2-')); try {
    const store = createMarketSnapshotStore({ staleAfterMs: 1, clock: testClock });
    // Write ticker with old timestamp (1 hour ago)
    const old = TEST_NOW - 3600_000;
    store.updateTicker({ ticker: mkTicker(EXCH, SYM, 50000, old), receivedAt: old });
    for (let i = 0; i < 200; i++) {
      const k = mkKline(EXCH, SYM, 49000 + i * 10, old - (200 - i) * 60_000);
      store.updateClosedKline({ kline: k, receivedAt: k.ts });
    }
    const candle = createCandleSeriesStore({ capacityPerSeries: 500 });
    for (let i = 0; i < 200; i++) {
      const k = mkKline(EXCH, SYM, 49000 + i * 10, old - (200 - i) * 60_000);
      candle.appendClosedKline({ kline: k, receivedAt: k.ts });
    }
    const ks = new KillSwitch(EXCH, { totalCapitalUsd: 100_000, maxPositionPct: 1, maxSinglePositionPct: 1, allowConcentration: true });
    const fp = new FastPipeline({
      exchange: EXCH,
      router: { exchange: EXCH, getBiasReport: () => ({ exchange: EXCH, updatedAt: TEST_NOW, assets: [{ symbol: SYM, direction: 'long' as const, confidence: 85, suggestedPositionPct: 0.1 }], whitelist: [SYM] }), getConfig: () => ({ maxBiasReportAgeHours: 24 }), killSwitch: ks },
      indicatorService: { calculateAll: async () => [momentumResult()] },
      marketData: { exchange: EXCH, snapshotStore: store, candleStore: candle, interval: '1m', minimumSeries: 100, seriesLimit: 200 },
      clock: testClock,
    });
    const s = await svc(d);
    const r = await new PaperFastPathCoordinator(fp, s, EXCH).run(SIG, P);
    assert.ok(r.pipelineResult.decision === 'defense' || r.pipelineResult.decision === 'skip');
    assert.equal(r.pipelineResult.executionQuote, undefined);
    assert.equal(r.paperEvent, undefined);
    assert.equal(s.snapshot().processedFills, 0);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('7. missing ticker: no quote, no paper, fills=0', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r2-')); try {
    const future = TEST_NOW;
    const store2 = createMarketSnapshotStore({ staleAfterMs: 60_000, clock: testClock });
    const candle2 = createCandleSeriesStore({ capacityPerSeries: 500 });
    for (let i = 0; i < 200; i++) {
      const k = mkKline(EXCH, SYM, 49000 + i * 10, future - (200 - i) * 60_000);
      store2.updateClosedKline({ kline: k, receivedAt: k.ts });
      candle2.appendClosedKline({ kline: k, receivedAt: k.ts });
    }
    const ks2 = new KillSwitch(EXCH, { totalCapitalUsd: 100_000, maxPositionPct: 1, maxSinglePositionPct: 1, allowConcentration: true });
    const fp2 = new FastPipeline({
      exchange: EXCH,
      router: { exchange: EXCH, getBiasReport: () => ({ exchange: EXCH, updatedAt: TEST_NOW, assets: [{ symbol: SYM, direction: 'long' as const, confidence: 85, suggestedPositionPct: 0.1 }], whitelist: [SYM] }), getConfig: () => ({ maxBiasReportAgeHours: 24 }), killSwitch: ks2 },
      indicatorService: { calculateAll: async () => [momentumResult()] },
      marketData: { exchange: EXCH, snapshotStore: store2, candleStore: candle2, interval: '1m', minimumSeries: 100, seriesLimit: 200 },
      clock: testClock,
    });
    const s = await svc(d);
    const r = await new PaperFastPathCoordinator(fp2, s, EXCH).run(SIG, P);
    assert.equal(r.pipelineResult.executionQuote, undefined);
    assert.equal(r.paperEvent, undefined);
    assert.equal(s.snapshot().processedFills, 0);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('8. missing kline: skip, no paper, fills=0', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's15r2-')); try {
    const future = TEST_NOW;
    const store3 = createMarketSnapshotStore({ staleAfterMs: 60_000, clock: testClock });
    store3.updateTicker({ ticker: mkTicker(EXCH, SYM, 50000, future), receivedAt: future });
    const ks3 = new KillSwitch(EXCH, { totalCapitalUsd: 100_000, maxPositionPct: 1, maxSinglePositionPct: 1, allowConcentration: true });
    const fp3 = new FastPipeline({
      exchange: EXCH,
      router: { exchange: EXCH, getBiasReport: () => ({ exchange: EXCH, updatedAt: TEST_NOW, assets: [{ symbol: SYM, direction: 'long' as const, confidence: 85, suggestedPositionPct: 0.1 }], whitelist: [SYM] }), getConfig: () => ({ maxBiasReportAgeHours: 24 }), killSwitch: ks3 },
      indicatorService: { calculateAll: async () => [momentumResult()] },
      marketData: { exchange: EXCH, snapshotStore: store3, candleStore: createCandleSeriesStore({ capacityPerSeries: 500 }), interval: '1m', minimumSeries: 100, seriesLimit: 200 },
      clock: testClock,
    });
    const s = await svc(d);
    const r = await new PaperFastPathCoordinator(fp3, s, EXCH).run(SIG, P);
    assert.equal(r.pipelineResult.decision, 'skip');
    assert.equal(r.paperEvent, undefined);
    assert.equal(s.snapshot().processedFills, 0);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
