/** Offline wire fixtures. The real Owner, Spine, Risk, OMS, adapters, parsers and recovery run. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTradingKernel } from '../../src/kernel/TradingKernel';
import { createFileEventJournal } from '../../src/recovery/FileEventJournal';
import { runGateIoProductionLiveCanary, GATEIO_CANARY_OPEN_MARK_DRIFT_RATIO, GATEIO_LIVE_CANARY_LIMITS,
  type GateIoLiveCanaryOptions } from '../../src/runtime/gateio/GateIoProductionLiveCanary';
import { parseGateIoLiveCanaryArguments } from '../../src/bin/gateio-production-live-canary';
import { GATEIO_READ_ENDPOINTS as E } from '../../src/runtime/gateio/GateIoReadContracts';
import { createApplicationProductionRuntimeOwner } from '../../src/runtime/production/ProductionRuntimeOwner';
import { activateLiveReadiness, executeThroughGateway } from '../../src/position/ProductionSpine';
import { createTradeIntent } from '../../src/types/trade-intent';
import { GateIoG3RunBudget } from '../../src/runtime/gateio/GateIoG3RunBudget';
import { GateIoCanaryCredentialError } from '../../src/runtime/gateio/GateIoCanaryCredentialFile';
import { multiplyQuantity } from '../../src/types/decimal-quantity';

const NOW = 1_800_000_000_000;
const HEAD = 'a'.repeat(40);
const KEY = 'OFFLINE_G6_FIXTURE_KEY';
const SECRET = 'OFFLINE_G6_FIXTURE_SECRET';
let sequence = 0;
function fixture(setup: { rejectOpen?: boolean; rejectClose?: boolean; rejectCleanup?: boolean;
  truthFailure?: 'once' | 'always'; unknown?: boolean; pending?: boolean; baselineSource?: string;
  partial?: 'open' | 'close'; missingPolicy?: boolean; missingBaseline?: boolean;
  initialExposure?: number; externalTrade?: boolean; minOrderSize?: number; decimalSizeEnabled?: boolean;
  rejectRecovery?: boolean; openOrderConflict?: boolean;
  snapshotMarkPrice?: number; adapterMarkPrice?: number; contractMultiplier?: number } = {}) {
  const accountId = 'g6-offline-' + ++sequence;
  const journalPath = join(mkdtempSync(join(tmpdir(), 'gate-g6-')), 'events.jsonl');
  const journal = createFileEventJournal(journalPath);
  const kernel = createTradingKernel({ exchange: 'gateio', journal, clock: { now: () => NOW },
    policyMaxLifetimeMs: 3_600_000 });
  const snapshotMarkPrice = setup.snapshotMarkPrice ?? 2000;
  const contractMultiplier = setup.contractMultiplier ?? 0.001;
  kernel.publish('market.ticker.updated', { ticker: { channel: 'ticker', exchange: 'gateio', instId: 'ETH/USDT',
    last: snapshotMarkPrice, bestBid: snapshotMarkPrice - 1, bestAsk: snapshotMarkPrice + 1,
    volume24h: 100, high24h: snapshotMarkPrice + 100, low24h: snapshotMarkPrice - 100, ts: NOW },
    receivedAt: NOW });
  if (!setup.missingBaseline) kernel.publish('position.baseline.confirmed', {
    baseline: { exchange: 'gateio', symbol: 'ETH/USDT', side: 'flat', signedQuantity: 0, averageEntryPrice: 0 },
    // Fixture fact, never created or synthesized by the launcher.
    evidence: { exchange: 'gateio', accountId, symbol: 'ETH/USDT', capturedAt: NOW,
      source: setup.baselineSource ?? 'gateio-live-read:capture-1', digest: 'b'.repeat(64), positionMode: 'single', baseline: 'flat' },
  });
  if (!setup.missingPolicy) kernel.publish('policy.snapshot.published', { policy: {
    exchange: 'gateio', sourceResearchEventId: 'a'.repeat(64), sourceResearchSequence: 1,
    compilerVersion: '1', compiledAt: NOW, effectiveAt: NOW, expiresAt: NOW + 3_600_000,
    allowNewEntries: true, allowedSymbols: [], blockedSymbols: [], allowedStrategyIds: [], blockedStrategyIds: [],
    maxPositionMultiplier: 1, riskLevel: 'low', directionBias: 'neutral', symbolRules: {}, reasonCodes: [],
  } });
  journal.close();
  let credentialReads = 0, repositoryReads = 0, posts = 0, accounts = 0, instrumentReads = 0;
  let currentInstrumentMark = snapshotMarkPrice;
  const observedInstrumentMarks: number[] = [];
  let exposure = setup.initialExposure ?? 0;
  const calls: { method: string; path: string; body?: any }[] = [];
  const orders = new Map<string, any>();
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const options: GateIoLiveCanaryOptions = { execute: true, expectedHead: HEAD, environment: 'live',
    symbol: 'ETH_USDT', accountId, journalPath, maxNotionalUsd: 10,
    permissions: { READ: true, TRADE: true, WITHDRAW: false, ROTATED: true } };
  const host = {
    inspectRepository: async () => { repositoryReads++; return { head: HEAD, clean: true }; },
    credentialProvider: async () => { credentialReads++; return { apiKey: KEY, secretKey: SECRET }; },
    now: () => NOW,
    fetchImpl: async (url: string, init: RequestInit) => {
      const parsed = new URL(url), path = parsed.pathname, method = init.method ?? 'GET';
      assert.equal(parsed.origin, 'https://api.gateio.ws');
      assert.ok(method === 'GET' || method === 'POST');
      const body = method === 'POST' ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (method === 'POST') {
        assert.equal(path, E.OPEN_ORDERS); posts++;
        if (posts === 1 && setup.rejectOpen) return response({ label: 'ORDER_REJECTED', message: SECRET }, 400);
        if ((posts === 2 && setup.rejectClose) || (posts === 3 && setup.rejectCleanup))
          return response({ label: 'ORDER_REJECTED', message: SECRET }, 400);
        if (posts >= 4 && setup.rejectRecovery) return response({ label: 'ORDER_REJECTED', message: SECRET }, 400);
        const partial = (setup.partial === 'open' && posts === 1) || (setup.partial === 'close' && posts === 2);
        const filled = partial ? body.size / 2 : body.size;
        exposure = Number((exposure + filled).toFixed(8));
        const order = { ...body, id: '1234567890123456' + posts, left: partial ? body.size - filled : 0,
          status: setup.pending ? 'open' : 'finished', finish_as: partial ? 'ioc' : 'filled',
          fill_price: String(currentInstrumentMark),
          finish_time: NOW / 1000, update_time: NOW / 1000 };
        orders.set(body.text, order);
        return response(setup.unknown ? {} : order);
      }
      if (path.startsWith(E.OPEN_ORDERS + '/')) {
        if (setup.unknown) return response({ label: 'ORDER_NOT_FOUND', message: SECRET }, 404);
        const order = orders.get(path.split('/').at(-1)!);
        assert.ok(order); return response(order);
      }
      if (path === E.SERVER_TIME) return response({ server_time: NOW });
      if (path === E.ACCOUNTS) {
        accounts++; return response({ currency: 'USDT', total: '1000', available: '900',
          in_dual_mode: false, position_mode: 'single', margin_mode: 0 });
      }
      if (path === E.POSITIONS) return response([{
        contract: 'ETH_USDT', mode: 'single', size: posts > 0 && (setup.truthFailure === 'always'
          || (setup.truthFailure === 'once' && accounts === 4)) ? 'invalid' : String(exposure),
        value: String(multiplyQuantity(multiplyQuantity(exposure, contractMultiplier), currentInstrumentMark)),
        entry_price: exposure ? String(currentInstrumentMark) : null,
        mark_price: exposure ? String(currentInstrumentMark) : null, update_time: String(NOW / 1000),
      }]);
      if (path === E.OPEN_ORDERS) return response(setup.openOrderConflict && posts > 0 ? [{
        id: '99999', text: 't-external-open-order', contract: 'ETH_USDT', size: 1, left: 1,
        price: '0', fill_price: '0', tif: 'ioc', status: 'open', is_reduce_only: false,
        is_close: false, create_time: NOW / 1000, update_time: NOW / 1000,
      }] : []);
      if (path === E.MY_TRADES) return response(setup.externalTrade && posts > 0 ? [{
        id: '9999', order_id: '8888', contract: 'ETH_USDT', size: '0.1', close_size: '0',
        price: '2000', text: 't-unrelated', fee: '0', point_fee: '0', role: 'taker', create_time: String(NOW / 1000),
      }] : []); // History lag on both sides must retain G3H semantics.
      if (path === E.CONTRACT) {
        currentInstrumentMark = ++instrumentReads === 1
          ? snapshotMarkPrice : setup.adapterMarkPrice ?? snapshotMarkPrice;
        return response({ name: 'ETH_USDT', status: 'trading', in_delisting: false,
        quanto_multiplier: String(contractMultiplier), order_size_min: String(setup.minOrderSize ?? (setup.partial ? 2 : 0.1)),
        order_size_max: '10000', enable_decimal: setup.decimalSizeEnabled ?? !setup.partial, order_price_round: '0.01', mark_price_round: '0.01',
        leverage_min: '1', leverage_max: '100', maker_fee_rate: '0', taker_fee_rate: '0' });
      }
      if (path === E.TICKERS) {
        observedInstrumentMarks.push(currentInstrumentMark);
        return response([{ contract: 'ETH_USDT',
        last: String(currentInstrumentMark), mark_price: String(currentInstrumentMark),
        index_price: String(currentInstrumentMark), funding_rate: '0',
        highest_bid: String(currentInstrumentMark - 1), lowest_ask: String(currentInstrumentMark + 1),
        high_24h: String(currentInstrumentMark + 100), low_24h: String(currentInstrumentMark - 100),
        volume_24h: '100' }]);
      }
      assert.fail('unexpected offline endpoint');
    },
  };
  return { options, host, calls, get posts() { return posts; }, get exposure() { return exposure; },
    get instrumentReads() { return instrumentReads; }, observedInstrumentMarks,
    get credentialReads() { return credentialReads; }, get repositoryReads() { return repositoryReads; },
    events() { return readFileSync(journalPath, 'utf8').trim().split('\n').map(s => JSON.parse(s).envelope); } };
}

/** Build a real pre-existing partial order on the SAME Owner/Spine/OMS, not synthetic fill events.
 * A minimum=quantum canary OPEN has no positive sub-quantum partial on the proven lattice.
 * This larger legitimate order proves recovery of partial exposure in the allowed configuration.
 */
async function seedPartialOpen(f: ReturnType<typeof fixture>) {
  const owner = createApplicationProductionRuntimeOwner({ enabled: true, mode: 'limited-live',
    exchange: 'gateio', environment: 'live', accountId: f.options.accountId!, journalPath: f.options.journalPath!,
    hardRisk: { enabled: true, locked: false, totalCapitalUsd: 10, maxSinglePositionPct: 1, maxSinglePositionAbsUsd: 10 },
    market: { entries: [{ symbol: 'ETH/USDT', exchangeSymbol: 'ETH_USDT', intervals: ['1m'], ticker: true }], staleAfterMs: 30_000 },
  }, { gateIo: { environment: 'live', accountId: f.options.accountId!, credential: { apiKey: KEY, secretKey: SECRET },
    fetchImpl: f.host.fetchImpl, now: f.host.now, runBudget: GateIoG3RunBudget.create(GATEIO_LIVE_CANARY_LIMITS) } });
  try {
    await owner.start(); const spine = owner.authoritativeSpine()!;
    await activateLiveReadiness(spine);
    const intent = createTradeIntent({ exchange: 'gateio', symbol: 'ETH/USDT', direction: 'long',
      positionUsd: 4, source: 'offline-recovery-fixture', reason: 'existing-partial-order', createdAt: NOW, biasUpdatedAt: NOW });
    await executeThroughGateway(spine, intent, 'open', 4);
    assert.equal(spine.positionStore.resolve('gateio', 'ETH/USDT').signedQuantity, 0.001);
    const order = spine.oms.getStore().list()[0]!;
    assert.equal(order.requestedQuantity, 0.002); assert.equal(order.cumulativeFilledQuantity, 0.001);
    return order;
  } finally { await owner.stop(); }
}

describe('Gate G6 production one-shot arming', () => {
  const denials: [string, Partial<GateIoLiveCanaryOptions>][] = [
    ['no execute', { execute: false }], ['testnet', { environment: 'testnet' }],
    ['other symbol', { symbol: 'BTC_USDT' }], ['missing expected head', { expectedHead: undefined }],
    ['wrong expected head', { expectedHead: 'b'.repeat(40) }], ['missing permissions', { permissions: undefined }],
    ['withdraw enabled', { permissions: { READ: true, TRADE: true, WITHDRAW: true, ROTATED: true } }],
    ['not rotated', { permissions: { READ: true, TRADE: true, WITHDRAW: false, ROTATED: false } }],
    ['no read', { permissions: { READ: false, TRADE: true, WITHDRAW: false, ROTATED: true } }],
    ['no trade', { permissions: { READ: true, TRADE: false, WITHDRAW: false, ROTATED: true } }],
    ['no journal', { journalPath: undefined }], ['no notional cap', { maxNotionalUsd: undefined }],
  ];
  for (const recoveryOnly of [false, true]) for (const [name, patch] of denials)
    it(`${recoveryOnly ? 'recovery' : 'normal'} ${name}: no credential load or network`, async () => {
    const f = fixture(); const r = await runGateIoProductionLiveCanary({ ...f.options, recoveryOnly, ...patch }, f.host);
    assert.equal(r.status, 'STOP'); assert.equal(r.budget.networkUsed, 0);
    assert.equal(f.credentialReads, 0); assert.equal(f.calls.length, 0);
    if (name === 'no execute') assert.equal(f.repositoryReads, 0);
  });
  it('dirty worktree denies before credential callback', async () => {
    const f = fixture(); const r = await runGateIoProductionLiveCanary(f.options,
      { ...f.host, inspectRepository: async () => ({ head: HEAD, clean: false }) });
    assert.equal(r.reason, 'DIRTY_WORKTREE'); assert.equal(f.credentialReads, 0); assert.equal(f.calls.length, 0);
  });
  it('repository changing during credential load denies before network', async () => {
    const f = fixture(); let reads = 0;
    const r = await runGateIoProductionLiveCanary(f.options, { ...f.host,
      inspectRepository: async () => ({ head: ++reads === 1 ? HEAD : 'b'.repeat(40), clean: true }) });
    assert.equal(r.reason, 'REPOSITORY_CHANGED'); assert.equal(f.calls.length, 0);
  });
  it('raw provider failure is sanitized', async () => {
    const f = fixture(); const r = await runGateIoProductionLiveCanary(f.options, { ...f.host,
      credentialProvider: async () => { throw new Error(KEY + SECRET + 'SIGN raw body'); } });
    assert.equal(r.reason, 'CREDENTIAL_UNAVAILABLE'); assert.equal(f.calls.length, 0);
    assert.equal(JSON.stringify(r).includes(SECRET), false);
  });
  it('typed containment denial survives without path/secret leakage or network', async () => {
    const f = fixture(); const r = await runGateIoProductionLiveCanary(f.options, { ...f.host,
      credentialProvider: async () => { throw new GateIoCanaryCredentialError('CREDENTIAL_INSIDE_GIT_WORKTREE'); } });
    assert.equal(r.reason, 'CREDENTIAL_INSIDE_GIT_WORKTREE'); assert.equal(f.calls.length, 0);
    for (const forbidden of [KEY, SECRET, 'SIGN', 'apiKey', 'secretKey', 'headers', 'raw body', f.options.journalPath!])
      assert.equal((JSON.stringify(r) + JSON.stringify(f.events())).includes(forbidden), false);
  });
  it('TestNet journal is not a production baseline; stops before credential loading', async () => {
    const f = fixture({ baselineSource: 'gateio-testnet-read:capture-1' });
    const r = await runGateIoProductionLiveCanary(f.options, f.host);
    assert.equal(r.reason, 'RECOVERED_LIVE_BASELINE_REQUIRED');
    assert.equal(f.credentialReads, 0); assert.equal(f.calls.length, 0);
  });
  it('real executable with no arguments is a zero-network STOP', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/bin/gateio-production-live-canary.ts'],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 2); assert.equal(result.stderr, '');
    const r = JSON.parse(result.stdout); assert.equal(r.reason, 'NOT_ARMED'); assert.equal(r.budget.networkUsed, 0);
  });
  it('CLI rejects unknown/duplicate flags and requires literal withdraw=false', () => {
    assert.throws(() => parseGateIoLiveCanaryArguments(['--execute', '--execute']));
    assert.throws(() => parseGateIoLiveCanaryArguments(['--recovery-only', '--recovery-only']));
    assert.equal(parseGateIoLiveCanaryArguments(['--recovery-only']).options.execute, false);
    assert.equal(parseGateIoLiveCanaryArguments(['--execute', '--recovery-only']).options.recoveryOnly, true);
    assert.throws(() => parseGateIoLiveCanaryArguments(['--secret=do-not-echo']));
    assert.equal(parseGateIoLiveCanaryArguments([]).options.permissions!.WITHDRAW, true);
    assert.equal(parseGateIoLiveCanaryArguments(['--permission-withdraw=false']).options.permissions!.WITHDRAW, false);
  });
});

describe('Gate G6 formal production path (offline injected wire)', () => {
  it('Owner -> Spine -> Risk -> OMS, minimum OPEN -> exact CLOSE -> fresh FLAT', async () => {
    const f = fixture(); const r = await runGateIoProductionLiveCanary(f.options, f.host);
    assert.equal(r.status, 'PASS', JSON.stringify(r)); assert.equal(r.ownerSpineCreations, 1);
    assert.equal(r.baselineVerified, true); assert.equal(r.finalExposure, 'FACTUAL_FLAT');
    assert.equal(r.budget.proofUsed, 2); assert.equal(r.budget.cleanupUsed, 0); assert.equal(f.posts, 2);
    assert.equal(r.limits.instrumentAcquisitions, 5);
    assert.equal(r.limits.networkRequests, 63);
    assert.equal(r.budget.instrumentUsed, 3);
    assert.deepEqual(f.calls.filter(c => c.method === 'POST').map(c => [c.body.size, c.body.reduce_only]),
      [[0.1, false], [-0.1, true]]);
    assert.equal(r.history, 'LAGGING');
    const fills = f.events().filter(e => e.type === 'execution.fill.confirmed');
    assert.equal(fills.length, 2); assert.equal(r.postRetryCount, 0);
    assert.equal(r.budget.networkUsed, f.calls.length);
    assert.ok(r.budget.networkUsed <= GATEIO_LIVE_CANARY_LIMITS.networkRequests);
    for (const secret of [KEY, SECRET, 'SIGN', 'headers', 'apiKey', 'secretKey'])
      assert.equal(JSON.stringify(r).includes(secret), false);
  });
  it('definite OPEN rejection and factual flat: no cleanup', async () => {
    const f = fixture({ rejectOpen: true }); const r = await runGateIoProductionLiveCanary(f.options, f.host);
    assert.equal(r.status, 'STOP'); assert.equal(r.finalExposure, 'FACTUAL_FLAT', JSON.stringify(r));
    assert.equal(f.posts, 1); assert.equal(r.cleanupAttempted, false);
  });
  it('post-mutation failure -> fresh nonflat -> one gateway cleanup -> FAIL_CLEANED_UP', async () => {
    const f = fixture({ truthFailure: 'once' }); const r = await runGateIoProductionLiveCanary(f.options, f.host);
    assert.equal(r.status, 'FAIL_CLEANED_UP', JSON.stringify(r)); assert.equal(r.finalExposure, 'FACTUAL_FLAT');
    assert.equal(r.budget.cleanupUsed, 1); assert.equal(r.budget.proofUsed, 1); assert.equal(f.posts, 2);
    assert.deepEqual(f.calls.filter(c => c.method === 'POST').map(c => c.body.reduce_only), [false, true]);
  });
  it('unknown post-submit exposure: no blind cleanup', async () => {
    const f = fixture({ truthFailure: 'always' }); const r = await runGateIoProductionLiveCanary(f.options, f.host);
    assert.equal(r.status, 'STOP'); assert.equal(r.finalExposure, 'UNKNOWN');
    assert.equal(f.posts, 1); assert.equal(r.cleanupAttempted, false);
  });
  it('rejected proof CLOSE reserves exactly one reduce-only cleanup, total three POSTs', async () => {
    const f = fixture({ rejectClose: true }); const r = await runGateIoProductionLiveCanary(f.options, f.host);
    assert.equal(r.status, 'FAIL_CLEANED_UP', JSON.stringify(r));
    assert.equal(r.budget.proofUsed, 2); assert.equal(r.budget.cleanupUsed, 1);
    assert.equal(r.budget.totalUsed, 3); assert.equal(f.posts, 3);
    assert.equal(r.finalExposure, 'FACTUAL_FLAT');
    assert.deepEqual(f.calls.filter(c => c.method === 'POST').map(c => [c.body.size, c.body.reduce_only]),
      [[0.1, false], [-0.1, true], [-0.1, true]]);
  });
  it('cleanup failure is not retried, does not claim FLAT or FAIL_CLEANED_UP', async () => {
    const f = fixture({ rejectClose: true, rejectCleanup: true });
    const r = await runGateIoProductionLiveCanary(f.options, f.host);
    assert.equal(r.status, 'STOP'); assert.equal(r.finalExposure, 'FACTUAL_NON_FLAT');
    assert.equal(f.posts, 3); assert.equal(r.budget.cleanupUsed, 1); assert.equal(r.cleanup?.status, 'REJECTED');
    assert.equal(r.budget.networkUsed, f.calls.length);
  });
  it('used canary journal cannot cause a second OPEN, even with the same execute flags', async () => {
    const f = fixture(); const first = await runGateIoProductionLiveCanary(f.options, f.host);
    assert.equal(first.status, 'PASS'); const count = f.calls.length;
    const second = await runGateIoProductionLiveCanary(f.options, f.host);
    assert.equal(second.reason, 'CANARY_JOURNAL_ALREADY_USED');
    assert.equal(f.calls.length, count); assert.equal(f.credentialReads, 1);
  });
  it('submission_unknown uses existing exact GET reconciliation, never repeats POST', async () => {
    const f = fixture({ unknown: true }); const r = await runGateIoProductionLiveCanary(f.options, f.host);
    assert.equal(r.status, 'STOP'); assert.equal(r.finalExposure, 'UNKNOWN');
    assert.equal(r.open?.status, 'SUBMISSION_UNKNOWN'); assert.equal(f.posts, 1);
    assert.ok(f.calls.some(c => c.path.startsWith(E.OPEN_ORDERS + '/')));
    assert.equal(r.cleanupAttempted, false); assert.equal(r.postRetryCount, 0);
  });
  for (const partial of ['open', 'close'] as const) it('G6R1 rejects minimum=2 before possible partial ' + partial, async () => {
    const f = fixture({ partial }); const r = await runGateIoProductionLiveCanary(f.options, f.host);
    assert.equal(r.status, 'STOP', JSON.stringify(r)); assert.equal(r.reason, 'CANARY_PARTIAL_RESIDUAL_NOT_CLOSEABLE');
    assert.equal(f.posts, 0); assert.equal(r.budget.totalUsed, 0); assert.equal(f.exposure, 0);
    assert.equal(r.open, null); assert.ok(f.calls.some(c => c.path === E.CONTRACT));
    assert.equal(f.events().filter(e => e.type === 'order.created').length, 0);
  });
  it('nonterminal partial cannot start a CLOSE or cleanup while the original order remains active', async () => {
    const f = fixture({ partial: 'open', pending: true, minOrderSize: 1 });
    const order = await seedPartialOpen(f); assert.equal(order.status, 'PARTIALLY_FILLED');
    const r = await runGateIoProductionLiveCanary({ ...f.options, recoveryOnly: true }, f.host);
    assert.equal(r.status, 'STOP'); assert.equal(r.budget.totalUsed, 0);
    assert.equal(r.finalExposure, 'UNKNOWN'); assert.equal(r.cleanupAttempted, false); assert.equal(f.posts, 1);
  });
  for (const missing of ['missingBaseline', 'missingPolicy'] as const) it(missing + ' never invented by launcher', async () => {
    const f = fixture({ [missing]: true }); const r = await runGateIoProductionLiveCanary(f.options, f.host);
    assert.equal(r.status, 'STOP'); assert.equal(f.posts, 0);
  });
  it('foreign/existing exposure fails closed, without OPEN or cleanup', async () => {
    const f = fixture({ initialExposure: 0.1 }); const r = await runGateIoProductionLiveCanary(f.options, f.host);
    assert.equal(r.status, 'STOP'); assert.equal(f.posts, 0); assert.equal(r.cleanupAttempted, false);
  });
  it('unattributed activity during history lag prevents cleanup and success', async () => {
    const f = fixture({ externalTrade: true }); const r = await runGateIoProductionLiveCanary(f.options, f.host);
    assert.equal(r.status, 'STOP'); assert.equal(r.finalExposure, 'UNKNOWN'); assert.equal(f.posts, 1);
  });
  it('launcher has no direct mutation, synthetic policy/baseline, second authority or autonomous loop', () => {
    const files = ['src/bin/gateio-production-live-canary.ts', 'src/runtime/gateio/GateIoProductionLiveCanary.ts'];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /submitMarketOrder|\.submitRequest\(|new OmsCore|\.kernel\.publish\(|trustBaseline\(/);
      assert.doesNotMatch(source, /process\.env|setInterval\(|setTimeout\(|TestnetOmsE2E|V4Signer/);
    }
  });
});

describe('Gate G8E minimum OPEN boundary through the formal offline canary path', () => {
  const mark = 2681.98;
  const multiplier = 0.01;
  const minimumNotionalUsd = multiplyQuantity(multiplyQuantity(0.1, multiplier), mark);
  const riskRequestedNotionalUsd = multiplyQuantity(minimumNotionalUsd,
    1 + GATEIO_CANARY_OPEN_MARK_DRIFT_RATIO);

  it('reproduces the spent canary arithmetic but obtains buffered Risk approval for exactly 0.1', async () => {
    assert.equal(GATEIO_CANARY_OPEN_MARK_DRIFT_RATIO, 0.001);
    assert.equal(minimumNotionalUsd, 2.68198);
    assert.ok(minimumNotionalUsd / (mark * multiplier) < 0.1);
    const f = fixture({ snapshotMarkPrice: mark, adapterMarkPrice: mark, contractMultiplier: multiplier });
    const r = await runGateIoProductionLiveCanary({ ...f.options, maxNotionalUsd: 2.956162 }, f.host);
    assert.equal(r.status, 'PASS', JSON.stringify(r));
    const open = f.calls.find(c => c.method === 'POST');
    assert.equal(open?.body.size, 0.1);
    assert.equal(open?.body.reduce_only, false);
    const created = f.events().filter(e => e.type === 'order.created');
    assert.equal(created.length, 2);
    assert.equal(created[0]!.payload.order.approvedNotionalUsd, riskRequestedNotionalUsd);
    assert.ok(minimumNotionalUsd <= created[0]!.payload.order.approvedNotionalUsd);
    assert.ok(f.instrumentReads >= 2);
    assert.deepEqual(f.observedInstrumentMarks.slice(0, 2), [mark, mark]);
    assert.deepEqual(f.calls.filter(c => c.method === 'POST').map(c => c.body.size), [0.1, -0.1]);
  });

  it('a fresh mark rise within the explicit 0.1% approval buffer keeps the target at 0.1', async () => {
    const freshMark = multiplyQuantity(mark, 1 + GATEIO_CANARY_OPEN_MARK_DRIFT_RATIO);
    const f = fixture({ snapshotMarkPrice: mark, adapterMarkPrice: freshMark, contractMultiplier: multiplier });
    const r = await runGateIoProductionLiveCanary({ ...f.options, maxNotionalUsd: 2.956162 }, f.host);
    assert.equal(r.status, 'PASS', JSON.stringify(r));
    const open = f.calls.find(c => c.method === 'POST');
    assert.equal(open?.body.size, 0.1);
    assert.equal(open?.body.reduce_only, false);
    assert.ok(freshMark > mark);
    assert.deepEqual(f.observedInstrumentMarks.slice(0, 2), [mark, freshMark]);
    assert.ok(f.instrumentReads >= 2);
    const approved = f.events().find(e => e.type === 'order.created')!.payload.order.approvedNotionalUsd;
    const required = multiplyQuantity(multiplyQuantity(open!.body.size, multiplier), freshMark);
    assert.equal(approved, riskRequestedNotionalUsd);
    assert.ok(required <= approved);
  });

  it('a fresh mark rise beyond the buffer rejects OPEN before POST', async () => {
    const f = fixture({ snapshotMarkPrice: mark, adapterMarkPrice: 2684.67, contractMultiplier: multiplier });
    const r = await runGateIoProductionLiveCanary({ ...f.options, maxNotionalUsd: 2.956162 }, f.host);
    assert.equal(r.status, 'STOP', JSON.stringify(r));
    assert.ok(2684.67 > multiplyQuantity(mark, 1 + GATEIO_CANARY_OPEN_MARK_DRIFT_RATIO));
    assert.deepEqual(f.observedInstrumentMarks.slice(0, 2), [mark, 2684.67]);
    assert.ok(f.instrumentReads >= 2);
    assert.equal(f.posts, 0);
    assert.equal(r.open?.status, 'REJECTED');
    assert.ok(multiplyQuantity(multiplyQuantity(0.1, multiplier), 2684.67) > riskRequestedNotionalUsd);
    assert.deepEqual(f.events().filter(e => e.type === 'order.rejected').map(e => e.payload.reason),
      ['NORMALIZED_SIZE_ZERO']);
    assert.equal(r.budget.proofUsed, 0);
    assert.equal(f.events().filter(e => e.type === 'execution.fill.confirmed').length, 0);
  });

  it('the cap applies to the Risk-requested buffered amount, before an OPEN order exists', async () => {
    assert.ok(minimumNotionalUsd < 2.683 && 2.683 < riskRequestedNotionalUsd);
    const f = fixture({ snapshotMarkPrice: mark, contractMultiplier: multiplier });
    const r = await runGateIoProductionLiveCanary({ ...f.options, maxNotionalUsd: 2.683 }, f.host);
    assert.equal(r.status, 'STOP', JSON.stringify(r));
    assert.equal(r.reason, 'MINIMUM_SIZE_EXCEEDS_CAP');
    assert.equal(f.posts, 0);
    assert.equal(r.budget.proofUsed, 0);
    assert.equal(f.events().filter(e => e.type === 'order.created').length, 0);
  });
});

describe('Gate G6R1 closeability and explicit recovery-only', () => {
  for (const [minOrderSize, decimalSizeEnabled] of [[1, false], [0.1, true]] as const)
    it(`minimum ${minOrderSize} on the supported lattice is allowed`, async () => {
      const f = fixture({ minOrderSize, decimalSizeEnabled });
      const r = await runGateIoProductionLiveCanary(f.options, f.host);
      assert.equal(r.status, 'PASS', JSON.stringify(r)); assert.equal(r.budget.totalUsed, 2);
      assert.deepEqual(f.calls.filter(c => c.method === 'POST').map(c => c.body.size), [minOrderSize, -minOrderSize]);
    });
  it('failed canary journal blocks normal OPEN but explicit recovery closes exactly the residual once', async () => {
    const f = fixture({ rejectClose: true, rejectCleanup: true });
    const failed = await runGateIoProductionLiveCanary(f.options, f.host);
    assert.equal(failed.finalExposure, 'FACTUAL_NON_FLAT'); assert.equal(f.posts, 3);
    const before = f.calls.length;
    const rerun = await runGateIoProductionLiveCanary(f.options, f.host);
    assert.equal(rerun.reason, 'CANARY_JOURNAL_ALREADY_USED'); assert.equal(f.calls.length, before);
    const r = await runGateIoProductionLiveCanary({ ...f.options, recoveryOnly: true }, f.host);
    assert.equal(r.status, 'RECOVERY_CLEANED_UP', JSON.stringify(r)); assert.equal(r.finalExposure, 'FACTUAL_FLAT');
    assert.equal(r.open, null); assert.equal(r.close, null); assert.equal(r.budget.proofUsed, 0);
    assert.equal(r.budget.cleanupUsed, 1); assert.equal(r.limits.proofMutations, 0); assert.equal(r.limits.totalMutations, 1);
    assert.equal(r.limits.instrumentAcquisitions, 3); assert.equal(r.limits.networkRequests, 55);
    const newPosts = f.calls.slice(before).filter(c => c.method === 'POST');
    assert.deepEqual(newPosts.map(c => [c.body.size, c.body.reduce_only]), [[-0.1, true]]);
    assert.equal(f.exposure, 0); assert.equal(r.postRetryCount, 0);
    const after = f.calls.length;
    assert.equal((await runGateIoProductionLiveCanary(f.options, f.host)).reason, 'CANARY_JOURNAL_ALREADY_USED');
    assert.equal(f.calls.length, after); // Recovery never grants permission for a new normal OPEN.
  });
  it('allowed lattice partial OPEN recovers factual delta then exact reduce-only closure (no replay)', async () => {
    const f = fixture({ partial: 'open', minOrderSize: 1 });
    assert.equal((await seedPartialOpen(f)).status, 'CANCELLED');
    const before = f.calls.length;
    const r = await runGateIoProductionLiveCanary({ ...f.options, recoveryOnly: true }, f.host);
    assert.equal(r.status, 'RECOVERY_CLEANED_UP', JSON.stringify(r)); assert.equal(f.exposure, 0);
    assert.deepEqual(f.calls.slice(before).filter(c => c.method === 'POST').map(c => [c.body.size, c.body.reduce_only]), [[-1, true]]);
    assert.equal(f.events().filter(e => e.type === 'execution.fill.confirmed').length, 2);
    assert.equal(r.budget.proofUsed, 0); assert.equal(r.budget.cleanupUsed, 1);
  });
  it('recovery of a completed FLAT journal has zero POST and is not canary PASS', async () => {
    const f = fixture(); await runGateIoProductionLiveCanary(f.options, f.host);
    const before = f.posts;
    const r = await runGateIoProductionLiveCanary({ ...f.options, recoveryOnly: true }, f.host);
    assert.equal(r.status, 'RECOVERY_FLAT', JSON.stringify(r)); assert.equal(r.finalExposure, 'FACTUAL_FLAT');
    assert.equal(f.posts, before); assert.equal(r.budget.totalUsed, 0); assert.equal(r.open, null);
  });
  for (const failure of ['truthFailure', 'openOrderConflict', 'externalTrade'] as const)
    it(`recovery ${failure} fails closed without POST`, async () => {
      const setup: Parameters<typeof fixture>[0] = { rejectClose: true, rejectCleanup: true };
      const f = fixture(setup); await runGateIoProductionLiveCanary(f.options, f.host);
      if (failure === 'truthFailure') setup.truthFailure = 'always'; else setup[failure] = true;
      const before = f.posts;
      const r = await runGateIoProductionLiveCanary({ ...f.options, recoveryOnly: true }, f.host);
      assert.equal(r.status, 'STOP'); assert.equal(r.finalExposure, 'UNKNOWN'); assert.equal(f.posts, before);
      assert.equal(r.budget.totalUsed, 0); assert.equal(r.cleanupAttempted, false);
    });
  it('recovery cleanup rejection is not retried and retains factual NONFLAT', async () => {
    const f = fixture({ rejectClose: true, rejectCleanup: true, rejectRecovery: true });
    await runGateIoProductionLiveCanary(f.options, f.host); const before = f.posts;
    const r = await runGateIoProductionLiveCanary({ ...f.options, recoveryOnly: true }, f.host);
    assert.equal(r.status, 'STOP'); assert.equal(r.finalExposure, 'FACTUAL_NON_FLAT');
    assert.equal(f.posts, before + 1); assert.equal(r.budget.cleanupUsed, 1); assert.equal(r.postRetryCount, 0);
  });
});
