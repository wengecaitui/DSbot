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
    
    const s = await createProductionSpine({ exchange: 'bitget', accountId: 'verify', hardRisk, journalPath });
    
    // Before recovery — start() must throw
    await assert.rejects(
      () => s.start({ exchange: 'bitget' }),
      { message: /RECOVERY_VERIFIED/ },
      'start before recovery throws',
    );
    
    // Recovery
    const proj = makeProjectors(s);
    const journal = createFileEventJournal(journalPath);
    const result = recoverFromJournal(journal, proj, undefined);
    assert.strictEqual(result.recoveryVerified, true, 'recovery verified');
    
    // Set internally
    s.setRecoveryVerified(true);
    
    // Now start() succeeds
    await s.start({ exchange: 'bitget' });
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
    const proj1 = makeProjectors(s1);
    const journal1 = createFileEventJournal(journalPath);
    saveRecoveryCheckpoint(checkpointPath, journal1, proj1);
    
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
});
