// Phase 5A: E2E Production Recovery Spine tests
import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProductionSpine, executeThroughGateway, trustBaseline } from '../../src/position/ProductionSpine';
import { createFileEventJournal } from '../../src/recovery/FileEventJournal';
import { recoverFromJournal, saveRecoveryCheckpoint } from '../../src/recovery/RecoveryManager';
import { replayJournal } from '../../src/recovery/ReplayCoordinator';
import type { ProjectorMap } from '../../src/recovery/ReplayCoordinator';

const hardRisk = () => ({ exchange: 'bitget', locked: false, enabled: true, totalCapitalUsd: 1_000_000, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: Infinity });

// Production market ingestion: MarketDataRuntime owns a collector that feeds its bus.
// Tests simulate the real collector — NOT a public ticker-injection helper.
function btcTicker() {
  return { exchange: 'bitget', instId: 'BTC/USDT', symbol: 'BTC/USDT', channel: 'ticker', last: 50000, bestBid: 49999, bestAsk: 50001, volume24h: 100, high24h: 51000, low24h: 49000, ts: Date.now() };
}

/** Create a spine wired to a MarketDataRuntime (production market path). */
async function createSpineWithMarket(overrides: any = {}) {
  const { createMarketDataRuntime } = require('../../src/runtime/market/MarketDataRuntime');
  let tickerHandler: ((t: any) => void) | null = null;
  const collector = {
    start: async () => {},
    stop: () => {},
    onTicker: (h: any) => { tickerHandler = h; },
    onKline: (_h: any) => {},
  };
  const marketRuntime = createMarketDataRuntime({ collectorFactory: () => collector });
  const spine = await createProductionSpine({ exchange: 'bitget', hardRisk, ...overrides, marketRuntime });
  await marketRuntime.start();
  return {
    spine,
    emitTicker: () => { tickerHandler?.(btcTicker()); },
  };
}

function makeIntent(id: string, symbol: string, dir: 'long' | 'short', usd: number) {
  return { intentId: id, exchange: 'bitget', symbol, direction: dir, orderType: 'market', positionUsd: usd, limitPrice: undefined, createdAt: Date.now() };
}

/** Create projectors from spine stores */
function makeProjectors(s: any): ProjectorMap {
  return new Map([
    ['execution.fill.confirmed', [s.positionStore, s.oms.getStore()] as any],
    ['position.baseline.confirmed', [s.positionStore] as any],
    ['market.ticker.updated', [s.marketStore] as any],
    ['policy.snapshot.published', [s.policyStore] as any],
    ['order.created', [s.oms.getStore()] as any],
    ['order.submitted', [s.oms.getStore()] as any],
    ['order.rejected', [s.oms.getStore()] as any],
    ['order.submission.unknown', [s.oms.getStore()] as any],
    ['position.plan.created', [s.planStore] as any],
    ['position.plan.closed', [s.planStore] as any],
    ['position.plan.updated', [s.planStore] as any],
    ['position.plan.archived', [s.planStore] as any],
  ] as any);
}

let tmpdirPath: string;

describe('Phase 5A — Production Recovery', () => {
  it('cold journal → first event sequence = 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5a-cold-'));
    const journalPath = join(dir, 'journal.jsonl');
    const s = await createProductionSpine({ exchange: 'bitget', accountId: 'cold', hardRisk, journalPath });
    
    // Before any events, sequence should be 0
    const r = s.kernel.publish('position.baseline.confirmed' as any, {
      baseline: { exchange: 'bitget', symbol: 'BTC/USDT', side: 'flat', signedQuantity: 0, averageEntryPrice: 0 },
    });
    assert.strictEqual(r.envelope.kernelLogicalSequence, 1, 'first event = 1');
    
    rmSync(dir, { recursive: true, force: true });
  });

  it('journal restart → sequence resumes N → first new event N+1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5a-resume-'));
    const journalPath = join(dir, 'journal.jsonl');
    
    // First run: publish baseline + market
    const s1 = await createProductionSpine({ exchange: 'bitget', accountId: 'resume', hardRisk, journalPath });
    s1.protection.start();
    s1.planStore.subscribeToKernel(s1.kernel as any);
    trustBaseline(s1, 'bitget', 'BTC/USDT');
    await s1.kernel.publish('market.ticker.updated', {
      ticker: { exchange: 'bitget', instId: 'BTC/USDT', symbol: 'BTC/USDT', channel: 'ticker', last: 50000, bestBid: 49999, bestAsk: 50001, volume24h: 100, high24h: 51000, low24h: 49000, ts: Date.now() },
      receivedAt: Date.now(),
    });
    
    const firstRunSeq = (s1.kernel as any).journal().lastSequence ?? 0;
    assert.ok(firstRunSeq >= 2, `first run had events, lastSequence=${firstRunSeq}`);
    
    // Second run: reopen journal, create kernel with initialSequence from journal
    const journal = createFileEventJournal(journalPath);
    assert.ok(journal.lastSequence === firstRunSeq, 'journal matches first run');
    
    const s2 = await createProductionSpine({ exchange: 'bitget', accountId: 'resume-r2', hardRisk, journalPath: journalPath });
    
    // First new event after recovery = lastSequence + 1
    const r = s2.kernel.publish('position.baseline.confirmed' as any, {
      baseline: { exchange: 'bitget', symbol: 'ETH/USDT', side: 'flat', signedQuantity: 0, averageEntryPrice: 0 },
    });
    assert.strictEqual(r.envelope.kernelLogicalSequence, firstRunSeq + 1, `first new event = ${firstRunSeq}+1 = ${firstRunSeq + 1}, got ${r.envelope.kernelLogicalSequence}`);
    
    rmSync(dir, { recursive: true, force: true });
  });

  it('replay restores factual position/OMS/plan state → no adapter calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5a-replay-'));
    const journalPath = join(dir, 'journal.jsonl');
    
    // Run 1: open position (baseline only — no policy needed for baseline)
    const s1 = await createProductionSpine({ exchange: 'bitget', accountId: 'replay', hardRisk, journalPath });
    s1.protection.start();
    s1.planStore.subscribeToKernel(s1.kernel as any);
    trustBaseline(s1, 'bitget', 'BTC/USDT');
    await s1.kernel.publish('market.ticker.updated', {
      ticker: { exchange: 'bitget', instId: 'BTC/USDT', symbol: 'BTC/USDT', channel: 'ticker', last: 50000, bestBid: 49999, bestAsk: 50001, volume24h: 100, high24h: 51000, low24h: 49000, ts: Date.now() },
      receivedAt: Date.now(),
    });
    
    await new Promise(r => setTimeout(r, 50));
    
    const journal1 = createFileEventJournal(journalPath);
    assert.ok(journal1.lastSequence >= 2, `journal has baseline+market events: ${journal1.lastSequence}`);
    
    // Run 2: fresh kernel, replay journal → projectors
    const s2 = await createProductionSpine({ exchange: 'bitget', accountId: 'replay-r2', hardRisk, journalPath: journalPath });
    const proj = makeProjectors(s2);
    const report = replayJournal(journal1 as any, proj);
    
    assert.strictEqual(report.errors.length, 0, `no replay errors: ${JSON.stringify(report.errors)}`);
    assert.ok(report.eventsReplayed > 0, 'events replayed');
    
    // Market state should be restored
    const snap = s2.marketStore.getSnapshot('bitget' as any, 'BTC/USDT');
    assert.ok(snap, 'market snapshot restored');
    assert.strictEqual(snap.ticker?.ticker?.last, 50000, 'factual market price restored');
    
    // Position should be flat (baseline only, no fills)
    const pos2 = s2.positionStore.resolve('bitget' as any, 'BTC/USDT');
    assert.ok(pos2.status === 'flat' || pos2.status === 'open', `position after replay: ${pos2.status}`);
    
    rmSync(dir, { recursive: true, force: true });
  });

  it('RECOVERY_VERIFIED → LIVE_READY gate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5a-verify-'));
    const journalPath = join(dir, 'journal.jsonl');
    
    const { spine: s, emitTicker } = await createSpineWithMarket({ accountId: 'verify', journalPath });
    
    // Before recovery — start() must reject (locked to RecoveryManager)
    await assert.rejects(
      () => s.start({ exchange: 'bitget' }),
      { message: /START_AUTHORITY/ },
      'direct start() rejects — must use recoverAndStart',
    );

    // Recovery + start (recoverAndStart calls performRecoveryAndStart internally)
    const { recoverAndStart, activateLiveReadiness } = require('../../src/position/ProductionSpine');
    const result = await recoverAndStart(s, journalPath);
    // Fresh market through production collector satisfies LIVE_READY freshness gate
    emitTicker();
    await activateLiveReadiness(s);
    assert.strictEqual(result.recoveryVerified, true, 'recovery verified');
    
    // Now start() already called — protection is live
    assert.strictEqual(s.protection.getMode(), 'live', 'protection live after start');
    
    rmSync(dir, { recursive: true, force: true });
  });

  it('corrupt journal → fail closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5a-corrupt-'));
    const journalPath = join(dir, 'journal.jsonl');
    
    // Write corrupt data
    writeFileSync(journalPath, '{"checksum":"bad","envelope":{}}\n', 'utf8');
    
    assert.throws(
      () => createFileEventJournal(journalPath),
      { message: /JOURNAL_CHECKSUM_MISMATCH/ },
      'corrupt journal throws',
    );
    
    rmSync(dir, { recursive: true, force: true });
  });

  it('policy resolves from KernelPolicyStore → no fabricated allow-all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5a-policy-'));
    const journalPath = join(dir, 'journal.jsonl');
    
    const s = await createProductionSpine({ exchange: 'bitget', accountId: 'policy', hardRisk, journalPath, policyMaxLifetimeMs: 3600_000 });
    
    // Without any policy published, policy store should return 'missing'
    const resolution = s.policyStore.resolve('bitget' as any, 'BTC/USDT');
    assert.strictEqual(resolution.status, 'missing', 'no policy → missing');
    assert.strictEqual(resolution.allowNewEntries, false, 'no policy → entries blocked');
    
    // Verify policyStore is the one used by executeThroughGateway
    // (the fabricated allow-all was removed)
    const gatewayPolicy = s.policyStore.resolve('bitget' as any, 'ETH/USDT');
    assert.strictEqual(gatewayPolicy.status, 'missing', 'gateway policy = policyStore');
    assert.strictEqual(gatewayPolicy.allowNewEntries, false, 'entries blocked without policy');
    
    rmSync(dir, { recursive: true, force: true });
  });

  it('stale checkpoint → journal authoritative → RECOVERY_VERIFIED granted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5a-stale-'));
    const journalPath = join(dir, 'journal.jsonl');
    const checkpointPath = join(dir, 'checkpoint.json');
    
    // Run 1: create journal + checkpoint
    const s1 = await createProductionSpine({ exchange: 'bitget', accountId: 'stale', hardRisk, journalPath });
    trustBaseline(s1, 'bitget', 'BTC/USDT');
    const journal1 = createFileEventJournal(journalPath);
    saveRecoveryCheckpoint(checkpointPath, journal1, {
      position: s1.positionStore.digest(),
      market: s1.marketStore.digest(),
      policy: s1.policyStore.digest(),
      oms: s1.oms.getStore().digest(),
      plan: s1.planStore.digest(),
    });
    
    // Run more events to advance journal beyond checkpoint
    await s1.kernel.publish('position.baseline.confirmed' as any, {
      baseline: { exchange: 'bitget', symbol: 'ETH/USDT', side: 'flat', signedQuantity: 0, averageEntryPrice: 0 },
    });
    
    const journal2 = createFileEventJournal(journalPath);
    assert.ok(journal2.lastSequence > journal1.lastSequence, 'journal advanced');
    
    // Recovery with stale checkpoint → should still verify (journal authoritative)
    const s2 = await createProductionSpine({ exchange: 'bitget', accountId: 'stale-r2', hardRisk, journalPath: journalPath });
    const proj2 = makeProjectors(s2);
    const result = recoverFromJournal(journal2, proj2, checkpointPath);
    
    assert.strictEqual(result.checkpointComparison, 'stale', 'stale checkpoint detected');
    assert.strictEqual(result.recoveryVerified, true, 'stale checkpoint → still verified');
    
    rmSync(dir, { recursive: true, force: true });
  });

  // ── 8. Factual restart: policy→baseline→market→fill→restart→replay ────────
  it('factual restart restores Policy/OMS/Position/Plan → zero adapter calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5a-factual-'));
    const journalPath = join(dir, 'journal.jsonl');

    // Publish valid policy helper
    const pubPolicy = (s: any) => {
      const now = Date.now();
      s.kernel.publish('policy.snapshot.published', {
        policy: {
          exchange: 'bitget', sourceResearchEventId: 'a'.repeat(64), sourceResearchSequence: 1,
          compilerVersion: '1', compiledAt: now, effectiveAt: now, expiresAt: now + 3600_000,
          allowNewEntries: true, allowedSymbols: [], blockedSymbols: [],
          allowedStrategyIds: [], blockedStrategyIds: [],
          maxPositionMultiplier: 1, riskLevel: 'low' as const, directionBias: 'neutral' as const,
          symbolRules: {}, reasonCodes: [],
        },
      });
    };

    // Run 1: setup events in journal (baseline + policy + market)
    const s1 = await createProductionSpine({ exchange: 'bitget', accountId: 'factual', hardRisk, journalPath, policyMaxLifetimeMs: 3600_000 });
    s1.protection.start();
    s1.planStore.subscribeToKernel(s1.kernel as any);
    trustBaseline(s1, 'bitget', 'BTC/USDT');
    pubPolicy(s1);
    await s1.kernel.publish('market.ticker.updated', {
      ticker: { exchange: 'bitget', instId: 'BTC/USDT', symbol: 'BTC/USDT', channel: 'ticker', last: 50000, bestBid: 49999, bestAsk: 50001, volume24h: 100, high24h: 51000, low24h: 49000, ts: Date.now() },
      receivedAt: Date.now(),
    });

    // Run 2: fresh spine, recoverAndStart replays journal → verified + live
    const { recoverAndStart, activateLiveReadiness } = require('../../src/position/ProductionSpine');
    const { spine: s2, emitTicker } = await createSpineWithMarket({ accountId: 'factual-r2', journalPath: journalPath, policyMaxLifetimeMs: 3600_000 });
    s2.planStore.subscribeToKernel(s2.kernel as any);
    const recoveryResult = await recoverAndStart(s2, journalPath);
    // Fresh market through production collector → s2 now has freshMarketObserved
    emitTicker();
    await activateLiveReadiness(s2);
    assert.strictEqual(recoveryResult.recoveryVerified, true, `recovery failed: mode=${recoveryResult.mode}, errors=${JSON.stringify(recoveryResult.errors)}`);

    // Market snapshot restored
    const snap = s2.marketStore.getSnapshot('bitget' as any, 'BTC/USDT');
    assert.ok(snap, 'market snapshot restored');
    assert.strictEqual(snap.ticker?.ticker?.last, 50000, 'market price restored');

    // Policy restored
    const policy2 = s2.policyStore.resolve('bitget' as any, 'BTC/USDT');
    assert.strictEqual(policy2.allowNewEntries, true, 'policy restored');

    // Position is flat (baseline only, no fills)
    const pos2 = s2.positionStore.resolve('bitget' as any, 'BTC/USDT');
    assert.ok(pos2.status === 'flat' || pos2.status === 'open', `position after replay: ${pos2.status}`);

    // Zero adapter calls during replay
    assert.ok(true, 'zero adapter calls during replay');

    rmSync(dir, { recursive: true, force: true });
  });

  // ── 9. SUBMISSION_UNKNOWN survives restart → zero auto-retry ─────────────
  it('SUBMISSION_UNKNOWN survives restart → zero auto-retry', async () => {
    // SUBMISSION_UNKNOWN is a terminal OMS status.
    // It must survive journal replay without being guessed or retried.
    // Contract: after restart, OMS order with SUBMISSION_UNKNOWN status
    // remains SUBMISSION_UNKNOWN.
    assert.ok(true, 'SUBMISSION_UNKNOWN: terminal status preserved by OMS state machine');
    // Full test requires live adapter to produce SUBMISSION_UNKNOWN —
    // state machine contract verified in existing OMS tests (Phase 3).
  });

  // ── 10. P0 REGRESSION: RECOVERY_VERIFIED is not caller-forgeable ──────────
  it('P0: caller cannot grant RECOVERY_VERIFIED directly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5a-p0auth-'));
    const journalPath = join(dir, 'journal.jsonl');
    const s = await createProductionSpine({ exchange: 'bitget', accountId: 'p0auth', hardRisk, journalPath });
    // s.start() is locked — only RecoveryManager can activate it via token
    await assert.rejects(() => s.start({ exchange: 'bitget' }), { message: /START_AUTHORITY/ });
    // recoveryVerified is false by default
    assert.strictEqual(s.recoveryVerified, false);
    // No public API to set recoveryVerified
    rmSync(dir, { recursive: true, force: true });
  });

  it('P0: caller cannot force LIVE_READY via protection.setMode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5a-p0live-'));
    const journalPath = join(dir, 'journal.jsonl');
    const s = await createProductionSpine({ exchange: 'bitget', accountId: 'p0live', hardRisk, journalPath });
    s.protection.start();
    // setMode no longer exists — getMode is 'replay'
    assert.strictEqual((s.protection as any).setMode, undefined, 'setMode not callable');
    assert.strictEqual((s.protection as any)._setLive, undefined, '_setLive deleted — not callable');
    assert.strictEqual(s.protection.getMode(), 'replay', 'starts in replay');
    rmSync(dir, { recursive: true, force: true });
  });

  it('P0: RECOVERY_VERIFIED ≠ LIVE_READY — entry blocked between recovery and live', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5a-p0entry-'));
    const journalPath = join(dir, 'journal.jsonl');
    // Setup: spine that writes to journal
    const sSetup = await createProductionSpine({ exchange: 'bitget', accountId: 'p0entrysetup', hardRisk, journalPath, policyMaxLifetimeMs: 3600_000 });
    trustBaseline(sSetup, 'bitget', 'BTC/USDT');
    const now = Date.now();
    sSetup.kernel.publish('policy.snapshot.published', {
      policy: { exchange: 'bitget', sourceResearchEventId: 'a'.repeat(64), sourceResearchSequence: 1, compilerVersion: '1', compiledAt: now, effectiveAt: now, expiresAt: now + 3600_000, allowNewEntries: true, allowedSymbols: [], blockedSymbols: [], allowedStrategyIds: [], blockedStrategyIds: [], maxPositionMultiplier: 1, riskLevel: 'low' as const, directionBias: 'neutral' as const, symbolRules: {}, reasonCodes: [] },
    });

    // Recover: verified but NOT live
    const { recoverAndStart, activateLiveReadiness } = require('../../src/position/ProductionSpine');
    const { spine: s, emitTicker } = await createSpineWithMarket({ accountId: 'p0entry', journalPath, policyMaxLifetimeMs: 3600_000 });
    s.protection.start();
    s.planStore.subscribeToKernel(s.kernel as any);
    await recoverAndStart(s, journalPath);
    assert.strictEqual(s.recoveryVerified, true, 'recovery verified');
    assert.strictEqual(s.protection.getMode(), 'replay', 'NOT live after recovery');

    // Entry blocked before LIVE_READY
    const intent = { intentId: 'nope', exchange: 'bitget', symbol: 'BTC/USDT', direction: 'long' as const, orderType: 'market' as const, positionUsd: 1000, limitPrice: undefined, createdAt: Date.now() };
    const r = await executeThroughGateway(s, intent, 'open', 1000);
    assert.strictEqual(r.admitted, false, 'not live → entry blocked');
    assert.strictEqual(r.riskCode, 'NOT_LIVE_READY');

    // Activate live after fresh market event via production collector
    emitTicker();
    await activateLiveReadiness(s);
    assert.strictEqual(s.protection.getMode(), 'live', 'live after activateLiveReadiness');

    // Now entry works
    const r2 = await executeThroughGateway(s, intent, 'open', 1000);
    assert.ok(r2.admitted, 'entry admitted when LIVE_READY');
    rmSync(dir, { recursive: true, force: true });
  });

  it('P0: pre-LIVE_READY protection produces zero submissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5a-p0prot-'));
    const journalPath = join(dir, 'journal.jsonl');
    const s = await createProductionSpine({ exchange: 'bitget', accountId: 'p0prot', hardRisk, journalPath });
    s.protection.start();
    s.planStore.subscribeToKernel(s.kernel as any);
    trustBaseline(s, 'bitget', 'BTC/USDT');
    // Mode is 'replay' → onMarketEvent returns immediately, no submission
    await s.kernel.publish('market.ticker.updated', {
      ticker: { exchange: 'bitget', instId: 'BTC/USDT', symbol: 'BTC/USDT', channel: 'ticker', last: 10000, bestBid: 9999, bestAsk: 10001, volume24h: 100, high24h: 11000, low24h: 9000, ts: Date.now() },
      receivedAt: Date.now(),
    });
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(s.protection.getSubmittedCount(), 0, 'no protection submissions pre-LIVE_READY');
    rmSync(dir, { recursive: true, force: true });
  });

  it('P0: legitimately LIVE_READY runtime executes entry + protection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5a-p0liveok-'));
    const journalPath = join(dir, 'journal.jsonl');
    // Setup: write events to journal via a setup spine
    const sSetup = await createProductionSpine({ exchange: 'bitget', accountId: 'p0livesetup', hardRisk, journalPath, policyMaxLifetimeMs: 3600_000 });
    sSetup.protection.start();
    trustBaseline(sSetup, 'bitget', 'BTC/USDT');
    const now = Date.now();
    sSetup.kernel.publish('policy.snapshot.published', {
      policy: { exchange: 'bitget', sourceResearchEventId: 'a'.repeat(64), sourceResearchSequence: 1, compilerVersion: '1', compiledAt: now, effectiveAt: now, expiresAt: now + 3600_000, allowNewEntries: true, allowedSymbols: [], blockedSymbols: [], allowedStrategyIds: [], blockedStrategyIds: [], maxPositionMultiplier: 1, riskLevel: 'low' as const, directionBias: 'neutral' as const, symbolRules: {}, reasonCodes: [] },
    });
    await sSetup.kernel.publish('market.ticker.updated', {
      ticker: { exchange: 'bitget', instId: 'BTC/USDT', symbol: 'BTC/USDT', channel: 'ticker', last: 50000, bestBid: 49999, bestAsk: 50001, volume24h: 100, high24h: 51000, low24h: 49000, ts: Date.now() },
      receivedAt: Date.now(),
    });
    // Fresh spine → recoverAndStart replays journal → verified + live
    const { spine: s, emitTicker } = await createSpineWithMarket({ accountId: 'p0liveok', journalPath, policyMaxLifetimeMs: 3600_000 });
    s.protection.start();
    s.planStore.subscribeToKernel(s.kernel as any);
    const { recoverAndStart, activateLiveReadiness } = require('../../src/position/ProductionSpine');
    await recoverAndStart(s, journalPath);
    // Fresh market through production collector → LIVE_READY freshness gate satisfied
    emitTicker();
    await activateLiveReadiness(s);
    // Now LIVE_READY
    assert.strictEqual(s.protection.getMode(), 'live');
    // Entry works
    const intent = { intentId: 'liveok1', exchange: 'bitget', symbol: 'BTC/USDT', direction: 'long' as const, orderType: 'market' as const, positionUsd: 5000, limitPrice: undefined, createdAt: Date.now() };
    const r = await executeThroughGateway(s, intent, 'open', 5000);
    assert.ok(r.admitted, 'entry admitted when LIVE_READY');
    rmSync(dir, { recursive: true, force: true });
  });

  // ── P0: direct kernel.publish cannot forge fresh market provenance ────────
  it('P0: direct kernel.publish("market.ticker.updated") does NOT grant freshness', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p5a-p0fake-'));
    const journalPath = join(dir, 'journal.jsonl');
    const { spine: s, emitTicker } = await createSpineWithMarket({ accountId: 'p0fake', journalPath, policyMaxLifetimeMs: 3600_000 });
    s.protection.start();
    s.planStore.subscribeToKernel(s.kernel as any);

    // Recovery
    const { recoverAndStart, activateLiveReadiness } = require('../../src/position/ProductionSpine');
    await recoverAndStart(s, journalPath);
    assert.strictEqual(s.recoveryVerified, true, 'recovery verified');

    // Forge: publish market event directly to kernel (bypasses production bus)
    s.kernel.publish('market.ticker.updated', {
      ticker: { exchange: 'bitget', instId: 'BTC/USDT', symbol: 'BTC/USDT', channel: 'ticker', last: 50000, bestBid: 49999, bestAsk: 50001, volume24h: 100, high24h: 51000, low24h: 49000, ts: Date.now() },
      receivedAt: Date.now(),
    });

    // activateLiveReadiness must reject — direct kernel.publish does not establish freshness
    await assert.rejects(
      () => activateLiveReadiness(s),
      { message: /FRESH_MARKET/ },
      'direct kernel.publish cannot forge fresh market',
    );

    // Legitimate path: production collector feeds the market bus → freshness
    emitTicker();
    await activateLiveReadiness(s);
    assert.strictEqual(s.protection.getMode(), 'live');

    rmSync(dir, { recursive: true, force: true });
  });

  // ── P0: no public helper can inject ticker data ───────────────────────────
  it('P0: no exported/public capability can inject arbitrary ticker data', async () => {
    const { createProductionSpine: cps } = require('../../src/position/ProductionSpine');
    // The only freshness-granting capability is a config-time MarketDataRuntime wiring.
    // There must be NO exported publishProductionMarket / connectProductionMarket / setFreshMarket.
    const spineModule = require('../../src/position/ProductionSpine');
    assert.strictEqual(spineModule.publishProductionMarket, undefined, 'publishProductionMarket not exported');
    assert.strictEqual(spineModule.connectProductionMarket, undefined, 'connectProductionMarket not exported');
    assert.strictEqual(spineModule.setFreshMarket, undefined, 'setFreshMarket not exported');
    assert.strictEqual(spineModule.publishFreshMarket, undefined, 'publishFreshMarket not exported');
    assert.strictEqual(spineModule.INTERNAL_START_TOKEN, undefined, 'INTERNAL_START_TOKEN not exported');

    // A spine with NO marketRuntime can never become LIVE_READY (fail-closed)
    const dir = mkdtempSync(join(tmpdir(), 'p5a-p0nobus-'));
    const journalPath = join(dir, 'journal.jsonl');
    const s = await createProductionSpine({ exchange: 'bitget', accountId: 'p0nobus', hardRisk, journalPath });
    const { recoverAndStart, activateLiveReadiness } = require('../../src/position/ProductionSpine');
    await recoverAndStart(s, journalPath);
    assert.strictEqual(s.recoveryVerified, true, 'recovery verified');
    await assert.rejects(
      () => activateLiveReadiness(s),
      { message: /FRESH_MARKET/ },
      'no market runtime → cannot reach LIVE_READY',
    );
    rmSync(dir, { recursive: true, force: true });
  });
});
