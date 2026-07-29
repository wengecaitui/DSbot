// Stage 4A1-R1: Registry identity + isolation tests — ≥36, no any, typed test doubles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PaperRuntimeRegistry, type PaperRuntimeBinding, type RegistryEntry } from '../../src/paper/PaperRuntimeRegistry';
import { PaperFastPathCoordinator } from '../../src/paper/PaperFastPathCoordinator';
import { PaperExecutionService } from '../../src/paper/PaperExecutionService';
import { PaperLedgerStore } from '../../src/paper/PaperLedgerStore';
import { FastPipeline } from '../../src/pipeline/FastPipeline';
import { KillSwitch } from '../../src/router/KillSwitch';
import { createMarketSnapshotStore } from '../../src/data/MarketSnapshotStore';
import { createCandleSeriesStore } from '../../src/data/CandleSeriesStore';
import type { ExchangeId } from '../../src/data/MarketIdentity';
import type { PaperAccountConfig } from '../../src/types/paper-account';

const EXCH_BG: ExchangeId = 'bitget';
const EXCH_BN: ExchangeId = 'binance';
const FUTURE = Date.now() + 120_000;

function mkTicker(ex: ExchangeId, sym: string, last: number, ts: number) {
  return { exchange: ex, instId: sym, channel: 'ticker' as const, last, bestBid: last - 1, bestAsk: last + 1, volume24h: 1000, high24h: last * 1.02, low24h: last * 0.98, ts };
}
function mkKline(ex: ExchangeId, sym: string, close: number, ts: number) {
  return { exchange: ex, instId: sym, channel: 'kline' as const, interval: '1m', open: close * 0.999, high: close * 1.001, low: close * 0.998, close, volume: 100, ts, confirm: true };
}
function momentumResult() {
  return { name: 'CompositeMomentum' as const, composite_score: 85, regime_state: 'STRONG_BULLISH' as const, in_cooldown: false, dimension_scores: { hull_big_trend: { value: 1, weight: 1 }, stc_momentum: { value: 1, weight: 1 }, volume_micro: { value: 1, weight: 1 } }, lag_bars: 0, elapsedMs: 0 };
}

async function makeBinding(accountId: string, exchange: ExchangeId, cash: number, symbol: string, direction: 'long' | 'short'): Promise<{ binding: PaperRuntimeBinding; dir: string; store: ReturnType<typeof createMarketSnapshotStore> }> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 's4a1r1-'));
  const store = createMarketSnapshotStore({ staleAfterMs: 60_000 });
  store.updateTicker({ ticker: mkTicker(exchange, symbol, 50000, FUTURE), receivedAt: FUTURE });
  const candle = createCandleSeriesStore({ capacityPerSeries: 500 });
  for (let i = 0; i < 200; i++) {
    const k = mkKline(exchange, symbol, 49000 + i * 10, FUTURE - (200 - i) * 60_000);
    store.updateClosedKline({ kline: k, receivedAt: k.ts });
    candle.appendClosedKline({ kline: k, receivedAt: k.ts });
  }
  const ac: PaperAccountConfig = { accountId, exchange, initialCashUsd: cash };
  const ks = new KillSwitch(exchange, { totalCapitalUsd: cash, maxPositionPct: 1, maxSinglePositionPct: 1, allowConcentration: true });
  let nextDomainTime = FUTURE - 60_000;
  let capturedDomainTime = nextDomainTime;
  const clock = { now: () => {
    capturedDomainTime = nextDomainTime++;
    return capturedDomainTime;
  } };
  const fp = new FastPipeline({
    exchange,
    router: { exchange, getBiasReport: () => ({ exchange, updatedAt: capturedDomainTime, assets: [{ symbol, direction, confidence: 85, suggestedPositionPct: 0.1 }], whitelist: [symbol] }), getConfig: () => ({ maxBiasReportAgeHours: 24 }), killSwitch: ks },
    indicatorService: { calculateAll: async () => [momentumResult()] },
    marketData: { exchange, snapshotStore: store, candleStore: candle, interval: '1m', minimumSeries: 100, seriesLimit: 200 },
    clock,
  });
  const svc = await PaperExecutionService.open(ac, new PaperLedgerStore(ac, { baseDir: d }));
  const coord = new PaperFastPathCoordinator(fp, svc, exchange);
  return { binding: { accountId, exchange, pipeline: fp, service: svc, coordinator: coord }, dir: d, store };
}

const SIG_BG = { exchange: EXCH_BG, symbol: 'BTCUSDT', source: 's' };
const SIG_BN = { exchange: EXCH_BN, symbol: 'ETHUSDT', source: 's' };
const P = { feeBps: 10, slippageBps: 5 };

// ═══ 1–6: Basic Registry ═══════════════════════════════════════
test('1. register + has + list', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(binding); assert.ok(r.has('a1', EXCH_BG)); assert.equal(r.list().length, 1); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('2. duplicate register rejected', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(binding); assert.throws(() => r.register(binding), /duplicate/); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('3. invalid exchange rejected', () => { const r = new PaperRuntimeRegistry(); assert.throws(() => r.has('x', 'bad' as ExchangeId), /exchange/); });
test('4. empty accountId rejected', () => { const r = new PaperRuntimeRegistry(); assert.throws(() => r.has('', EXCH_BG), /accountId/); });
test('5. unregister', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(binding); assert.ok(r.unregister('a1', EXCH_BG)); assert.ok(!r.has('a1', EXCH_BG)); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('6. list returns RegistryEntry[] not binding', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(binding); const xs: readonly RegistryEntry[] = r.list(); assert.equal(xs[0].accountId, 'a1'); assert.ok(!('pipeline' in xs[0])); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ═══ 7–10: Routing ════════════════════════════════════════════
test('7. bg trade via registry', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(binding); const res = await r.run('a1', SIG_BG, P); assert.equal(res.paperEvent!.status, 'applied'); assert.equal(r.snapshot('a1', EXCH_BG).processedFills, 1); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('8. bn trade via registry', async () => {
  const { binding, dir } = await makeBinding('a2', EXCH_BN, 100_000, 'ETHUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(binding); const res = await r.run('a2', SIG_BN, P); assert.equal(res.paperEvent!.status, 'applied'); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('9. unknown route rejects', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(binding); await assert.rejects(() => r.run('a1', SIG_BN, P), /no binding/); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('10. symbol not in whitelist → skip', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(binding); const res = await r.run('a1', { exchange: EXCH_BG, symbol: 'ETHUSDT', source: 's' }, P); assert.equal(res.pipelineResult.decision, 'skip'); assert.equal(res.paperEvent, undefined); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ═══ 11–14: Cross-exchange isolation ══════════════════════════
test('11. dual exchange independent balances', async () => {
  const b1 = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const b2 = await makeBinding('a1', EXCH_BN, 200_000, 'ETHUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(b1.binding); r.register(b2.binding); await r.run('a1', SIG_BG, P); await r.run('a1', SIG_BN, P); const s1 = r.snapshot('a1', EXCH_BG); const s2 = r.snapshot('a1', EXCH_BN); assert.equal(s1.processedFills, 1); assert.equal(s2.processedFills, 1); assert.notStrictEqual(s1, s2); }
  finally { await fs.rm(b1.dir, { recursive: true, force: true }); await fs.rm(b2.dir, { recursive: true, force: true }); }
});
test('12. cross-account same exchange isolated', async () => {
  const b1 = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const b2 = await makeBinding('a2', EXCH_BG, 200_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(b1.binding); r.register(b2.binding); await r.run('a1', SIG_BG, P); await r.run('a2', SIG_BG, P); assert.equal(r.snapshot('a1', EXCH_BG).processedFills, 1); assert.equal(r.snapshot('a2', EXCH_BG).processedFills, 1); }
  finally { await fs.rm(b1.dir, { recursive: true, force: true }); await fs.rm(b2.dir, { recursive: true, force: true }); }
});
test('13. concurrent cross-exchange', async () => {
  const b1 = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const b2 = await makeBinding('a1', EXCH_BN, 200_000, 'ETHUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(b1.binding); r.register(b2.binding); const [r1, r2] = await Promise.all([r.run('a1', SIG_BG, P), r.run('a1', SIG_BN, P)]); assert.equal(r1.paperEvent!.status, 'applied'); assert.equal(r2.paperEvent!.status, 'applied'); }
  finally { await fs.rm(b1.dir, { recursive: true, force: true }); await fs.rm(b2.dir, { recursive: true, force: true }); }
});
test('14. deterministic list', async () => {
  const b1 = await makeBinding('b', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const b2 = await makeBinding('a', EXCH_BN, 200_000, 'ETHUSDT', 'long');
  const b3 = await makeBinding('a', EXCH_BG, 150_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(b3.binding); r.register(b1.binding); r.register(b2.binding); const xs = r.list(); assert.equal(xs.length, 3); assert.equal(xs[0].accountId, 'a'); assert.equal(xs[0].exchange, EXCH_BN); assert.equal(xs[1].accountId, 'a'); assert.equal(xs[1].exchange, EXCH_BG); assert.equal(xs[2].accountId, 'b'); assert.equal(xs[2].exchange, EXCH_BG); }
  finally { await fs.rm(b1.dir, { recursive: true, force: true }); await fs.rm(b2.dir, { recursive: true, force: true }); await fs.rm(b3.dir, { recursive: true, force: true }); }
});

// ═══ 15–21: Binding mismatch ══════════════════════════════════
test('15. duplicate local: same acct → 2 fills, other acct → 1 fill', async () => {
  const bA = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const bB = await makeBinding('a2', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(bA.binding); r.register(bB.binding);
    // Account A: two runs → 2 fills (different intentIds → both applied)
    await r.run('a1', SIG_BG, P); await r.run('a1', SIG_BG, P);
    // Account B: one run → 1 fill
    await r.run('a2', SIG_BG, P);
    assert.equal(r.snapshot('a1', EXCH_BG).processedFills, 2);
    assert.equal(r.snapshot('a2', EXCH_BG).processedFills, 1);
  } finally { await fs.rm(bA.dir, { recursive: true, force: true }); await fs.rm(bB.dir, { recursive: true, force: true }); }
});

test('16. pipeline exchange mismatch rejects', async () => {
  const b1 = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const b2 = await makeBinding('a1', EXCH_BN, 100_000, 'ETHUSDT', 'long');
  try { const r = new PaperRuntimeRegistry();
    // Use bn pipeline with bg exchange in binding → mismatch
    const bad: PaperRuntimeBinding = { ...b1.binding, exchange: EXCH_BN as ExchangeId };
    assert.throws(() => r.register(bad), /pipeline exchange mismatch/);
    assert.equal(r.list().length, 0);
  } finally { await fs.rm(b1.dir, { recursive: true, force: true }); await fs.rm(b2.dir, { recursive: true, force: true }); }
});

test('17. service accountId mismatch rejects', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry();
    const bad: PaperRuntimeBinding = { ...binding, accountId: 'a2' };
    assert.throws(() => r.register(bad), /service accountId mismatch/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('18. service exchange mismatch rejects', async () => {
  const b1 = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const b2 = await makeBinding('a1', EXCH_BN, 100_000, 'ETHUSDT', 'long');
  try { const r = new PaperRuntimeRegistry();
    // bg pipeline, binding claims bg → pipeline ok. But bn service → service exchange mismatch
    const bad: PaperRuntimeBinding = { ...b1.binding, service: b2.binding.service };
    assert.throws(() => r.register(bad), /service exchange mismatch/);
    assert.equal(r.list().length, 0);
  } finally { await fs.rm(b1.dir, { recursive: true, force: true }); await fs.rm(b2.dir, { recursive: true, force: true }); }
});

test('19. coordinator exchange mismatch rejects', async () => {
  const b1 = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const b2 = await makeBinding('a1', EXCH_BN, 100_000, 'ETHUSDT', 'long');
  try { const r = new PaperRuntimeRegistry();
    // bg pipeline + bg service, but bn coordinator → coordinator exchange mismatch
    const bad: PaperRuntimeBinding = { ...b1.binding, coordinator: b2.binding.coordinator };
    assert.throws(() => r.register(bad), /coordinator exchange mismatch/);
  } finally { await fs.rm(b1.dir, { recursive: true, force: true }); await fs.rm(b2.dir, { recursive: true, force: true }); }
});

test('20. coordinator bound to different pipeline rejects', async () => {
  const b1 = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const b2 = await makeBinding('a1', EXCH_BG, 200_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry();
    // Same exchange, different pipeline instance → isBoundTo fails
    const bad: PaperRuntimeBinding = { ...b1.binding, pipeline: b2.binding.pipeline };
    assert.throws(() => r.register(bad), /coordinator not bound to given pipeline/);
  } finally { await fs.rm(b1.dir, { recursive: true, force: true }); await fs.rm(b2.dir, { recursive: true, force: true }); }
});

test('21. coordinator bound to different service rejects', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry();
    const bogusSvc = null as unknown as PaperExecutionService;
    const coord = new PaperFastPathCoordinator(binding.pipeline, bogusSvc, EXCH_BG);
    const bad: PaperRuntimeBinding = { ...binding, coordinator: coord };
    assert.throws(() => r.register(bad), /coordinator not bound/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ═══ 22–25: Edge routing ══════════════════════════════════════
test('22. invalid exchange in has rejects', () => { const r = new PaperRuntimeRegistry(); assert.throws(() => r.has('a1', 'nope' as ExchangeId), /exchange/); });
test('23. invalid exchange in unregister rejects', () => { const r = new PaperRuntimeRegistry(); assert.throws(() => r.unregister('a1', 'bad' as ExchangeId), /exchange/); });
test('24. whitespace-only accountId rejects', () => { const r = new PaperRuntimeRegistry(); assert.throws(() => r.has('  ', EXCH_BG), /accountId/); });
test('25. snapshot missing binding rejects', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(binding); assert.throws(() => r.snapshot('ghost', EXCH_BG), /no binding/); } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ═══ 26–29: Restart + unregister persistence ══════════════════
test('26. restart isolation: single binding', async () => {
  const b1 = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(b1.binding); await r.run('a1', SIG_BG, P);
    const svc2 = await PaperExecutionService.open({ accountId: 'a1', exchange: EXCH_BG, initialCashUsd: 100_000 }, new PaperLedgerStore({ accountId: 'a1', exchange: EXCH_BG, initialCashUsd: 100_000 }, { baseDir: b1.dir }));
    assert.equal(svc2.snapshot().processedFills, 1);
  } finally { await fs.rm(b1.dir, { recursive: true, force: true }); }
});

test('27. restart isolation: dual binding', async () => {
  const b1 = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  const b2 = await makeBinding('a1', EXCH_BN, 200_000, 'ETHUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(b1.binding); r.register(b2.binding);
    await r.run('a1', SIG_BG, P); await r.run('a1', SIG_BN, P);
    const svc1 = await PaperExecutionService.open({ accountId: 'a1', exchange: EXCH_BG, initialCashUsd: 100_000 }, new PaperLedgerStore({ accountId: 'a1', exchange: EXCH_BG, initialCashUsd: 100_000 }, { baseDir: b1.dir }));
    const svc2 = await PaperExecutionService.open({ accountId: 'a1', exchange: EXCH_BN, initialCashUsd: 200_000 }, new PaperLedgerStore({ accountId: 'a1', exchange: EXCH_BN, initialCashUsd: 200_000 }, { baseDir: b2.dir }));
    assert.equal(svc1.snapshot().processedFills, 1);
    assert.equal(svc2.snapshot().processedFills, 1);
    assert.notStrictEqual(svc1.snapshot(), svc2.snapshot());
  } finally { await fs.rm(b1.dir, { recursive: true, force: true }); await fs.rm(b2.dir, { recursive: true, force: true }); }
});

test('28. unregister blocks routing, ledger intact', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(binding); await r.run('a1', SIG_BG, P);
    r.unregister('a1', EXCH_BG);
    await assert.rejects(() => r.run('a1', SIG_BG, P), /no binding/);
    // Re-open same ledger → state preserved
    const svc2 = await PaperExecutionService.open({ accountId: 'a1', exchange: EXCH_BG, initialCashUsd: 100_000 }, new PaperLedgerStore({ accountId: 'a1', exchange: EXCH_BG, initialCashUsd: 100_000 }, { baseDir: dir }));
    assert.equal(svc2.snapshot().processedFills, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('29. list returns new array each call', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(binding); const a = r.list(); const b = r.list(); assert.notStrictEqual(a, b); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ═══ 30–36: Transaction + edge proofs ═════════════════════════
test('30. two fills same binding through registry', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(binding);
    await r.run('a1', SIG_BG, P); await r.run('a1', SIG_BG, P);
    assert.equal(r.snapshot('a1', EXCH_BG).processedFills, 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('31. unknown accountId run rejects', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(binding);
    await assert.rejects(() => r.run('ghost', SIG_BG, P), /no binding/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('32. wrong exchange run rejects', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const r = new PaperRuntimeRegistry(); r.register(binding);
    await assert.rejects(() => r.run('a1', { exchange: EXCH_BN, symbol: 'BTCUSDT', source: 's' }, P), /no binding/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('33. getIdentity() returns correct accountId+exchange', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { const id = binding.service.getIdentity(); assert.equal(id.accountId, 'a1'); assert.equal(id.exchange, EXCH_BG); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('34. FastPipeline.getExchange() returns correct exchange', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { assert.equal(binding.pipeline.getExchange(), EXCH_BG); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('35. coordinator.isBoundTo same objects → true', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { assert.ok(binding.coordinator.isBoundTo(binding.pipeline, binding.service, EXCH_BG)); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('36. coordinator.isBoundTo wrong exchange → false', async () => {
  const { binding, dir } = await makeBinding('a1', EXCH_BG, 100_000, 'BTCUSDT', 'long');
  try { assert.ok(!binding.coordinator.isBoundTo(binding.pipeline, binding.service, EXCH_BN)); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});
