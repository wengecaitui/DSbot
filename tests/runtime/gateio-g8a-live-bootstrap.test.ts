/** Offline only: the real transport/parser/truth port/Spine/journal, with injected wire fixtures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createKernelPositionStateStore } from '../../src/kernel/KernelPositionStateStore';
import { createKernelPolicyStore } from '../../src/kernel/KernelPolicyStore';
import { createProductionSpine, type ProductionSpine } from '../../src/position/ProductionSpine';
import { createFileEventJournal } from '../../src/recovery/FileEventJournal';
import { recoverFromJournal } from '../../src/recovery/RecoveryManager';
import type { ProjectorMap } from '../../src/recovery/ReplayCoordinator';
import { createGateIoExecutionTruthPort } from '../../src/reconciliation/GateIoExecutionTruthPort';
import { createGateIoAuthenticatedReadFoundation,
  type GateIoCanonicalAccountTruth } from '../../src/runtime/gateio/GateIoAuthenticatedReadFoundation';
import { GATEIO_READ_ENDPOINTS as E } from '../../src/runtime/gateio/GateIoReadContracts';
import { createGateIoReadTransport, createGateIoTestnetReadTransport } from '../../src/runtime/gateio/GateIoReadTransport';
import { GateIoG3RunBudget, GATEIO_G3_LIMITS } from '../../src/runtime/gateio/GateIoG3RunBudget';
import { establishVerifiedExternalFlatBaseline } from '../../src/runtime/gateio/establishVerifiedExternalFlatBaseline';
import { establishVerifiedLiveFlatBaseline, verifyGateIoLiveFlatBaseline } from '../../src/runtime/gateio/establishVerifiedLiveFlatBaseline';
import { bootstrapGateIoLiveJournal } from '../../src/runtime/gateio/GateIoLiveBootstrap';
import type { CompiledPolicy } from '../../src/types/policy-snapshot';

const NOW = 1_800_000_000_000;
const ACCOUNT = 'g8a-offline-account';
const LIFETIME = 3_600_000;

// Operator-supplied TEST policy only. No production launcher constructs these values.
function operatorPolicy(): CompiledPolicy {
  return { exchange: 'gateio', sourceResearchEventId: 'a'.repeat(64), sourceResearchSequence: 1,
    compilerVersion: 'explicit-operator-fixture', compiledAt: NOW, effectiveAt: NOW, expiresAt: NOW + LIFETIME,
    allowNewEntries: true, allowedSymbols: ['ETH/USDT'], blockedSymbols: [],
    allowedStrategyIds: ['approved-strategy'], blockedStrategyIds: [], maxPositionMultiplier: 0.25,
    directionBias: 'neutral', riskLevel: 'medium', symbolRules: {}, reasonCodes: ['OPERATOR_APPROVED'] };
}

async function harness(options: {
  environment?: 'live' | 'testnet'; dual?: boolean; exposure?: number; unknown?: boolean;
  openOrder?: boolean; positions?: unknown[]; accountId?: string; initialTime?: number;
  kernelPolicyLifetime?: number;
  transformAccount?: (account: GateIoCanonicalAccountTruth) => GateIoCanonicalAccountTruth;
} = {}) {
  let time = options.initialTime ?? NOW;
  const now = () => time;
  const environment = options.environment ?? 'live';
  const accountId = options.accountId ?? ACCOUNT;
  const journalPath = join(mkdtempSync(join(tmpdir(), 'gate-g8a-')), 'bootstrap.jsonl');
  const journal = createFileEventJournal(journalPath);
  const budget = GateIoG3RunBudget.create({ ...GATEIO_G3_LIMITS, accountAcquisitions: 8, networkRequests: 50 });
  const requests: string[] = [];
  let historicalPrice = '2000';
  let newExternalTrade = false;
  const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
  const fetchImpl = async (url: string, init: RequestInit) => {
    assert.equal(init.method, 'GET');
    const path = new URL(url).pathname;
    requests.push(path);
    if (path === E.SERVER_TIME) return response({ server_time: time });
    if (path === E.ACCOUNTS) return response({ currency: 'USDT', total: '1000', available: '900',
      in_dual_mode: options.dual ?? false, position_mode: options.dual ? 'dual' : 'single', margin_mode: 0 });
    if (path === E.POSITIONS) {
      if (options.unknown) return response([{ contract: 'ETH_USDT', size: 'invalid' }]);
      return response(options.positions ?? (options.dual ? ['dual_long', 'dual_short'] : ['single']).map(mode => ({
        contract: 'ETH_USDT', mode, size: String(options.exposure ?? 0), value: String((options.exposure ?? 0) * 2),
        entry_price: options.exposure ? '2000' : null, mark_price: options.exposure ? '2000' : null,
        update_time: String(time / 1000),
      })));
    }
    if (path === E.OPEN_ORDERS) return response(options.openOrder ? [{ id: '90001', text: 't-external',
      contract: 'ETH_USDT', size: 1, left: 1, price: '0', fill_price: '0', tif: 'ioc', status: 'open',
      is_reduce_only: false, is_close: false, create_time: time / 1000, update_time: time / 1000 }] : []);
    if (path === E.MY_TRADES) {
      const historical = { id: '42', order_id: '41', contract: 'ETH_USDT', size: '0.1', close_size: '0',
        price: historicalPrice, text: 't-historical', fee: '0', point_fee: '0', role: 'taker',
        create_time: String((NOW - 1000) / 1000) };
      return response(newExternalTrade ? [historical, { ...historical, id: '43', create_time: String(time / 1000) }]
        : [historical]);
    }
    if (path === E.CONTRACT) return response({ name: 'ETH_USDT', status: 'trading', in_delisting: false,
      quanto_multiplier: '0.001', order_size_min: '0.1', order_size_max: '10000', enable_decimal: true,
      order_price_round: '0.01', mark_price_round: '0.01', leverage_min: '1', leverage_max: '100',
      maker_fee_rate: '0', taker_fee_rate: '0' });
    if (path === E.TICKERS) return response([{ contract: 'ETH_USDT', last: '2000', mark_price: '2000',
      index_price: '2000', funding_rate: '0' }]);
    assert.fail('Unexpected offline endpoint');
  };
  const transport = environment === 'live' ? createGateIoReadTransport(fetchImpl, budget)
    : createGateIoTestnetReadTransport(fetchImpl, budget);
  const foundation = createGateIoAuthenticatedReadFoundation({ transport, runBudget: budget, now,
    identity: { exchange: 'gateio', accountId, settle: 'USDT' },
    credential: { apiKey: 'G8A_OFFLINE_FIXTURE_KEY', secretKey: 'G8A_OFFLINE_FIXTURE_SECRET' } });
  let spine: ProductionSpine;
  const port = createGateIoExecutionTruthPort({ environment, transport, runBudget: budget, accountId, now,
    foundation: { instrumentFacts: () => foundation.instrumentFacts(), accountTruth: async () => {
      const result = await foundation.accountTruth();
      return result.value && options.transformAccount
        ? { ...result, value: options.transformAccount(result.value) } : result;
    } }, listOmsOrders: () => spine.oms.getStore().list() });
  spine = await createProductionSpine({ exchange: 'gateio', accountId, journal, clock: { now },
    policyMaxLifetimeMs: options.kernelPolicyLifetime ?? LIFETIME,
    hardRisk: () => { assert.fail('Risk must not be invoked by bootstrap'); },
    execution: { mode: 'limited-live', truthPort: port,
      adapter: { submit: async () => { assert.fail('Mutation must be unreachable'); } } } });
  const truth = await port.acquireTruth();
  const baseline = { truthPort: port, truth, kernel: spine.kernel, positionStore: spine.positionStore,
    oms: spine.oms, accountId, symbol: 'ETH/USDT', now };
  const input = { spine, journal, journalPath, truthPort: port, truth, accountId, now,
    policy: operatorPolicy(), policyMaxLifetimeMs: LIFETIME };
  return { spine, port, truth, baseline, input, journal, journalPath, requests,
    setTime(value: number) { time = value; }, changeHistoricalTrade() { historicalPrice = '2001'; },
    addExternalTrade() { newExternalTrade = true; } };
}

describe('Gate G8A LIVE-only factual baseline', () => {
  for (const dual of [false, true]) it(`factual ${dual ? 'dual' : 'single'} zero legs: digest-bound, exactly once`, async () => {
    const h = await harness({ dual });
    const calls = h.requests.length;
    const evidence = establishVerifiedLiveFlatBaseline(h.baseline);
    assert.match(evidence.source, /^gateio-live-read:capture-[1-9][0-9]*$/);
    assert.equal(evidence.positionMode, dual ? 'dual' : 'single');
    assert.equal(evidence.digest, createHash('sha256').update(JSON.stringify({
      exchange: 'gateio', accountId: ACCOUNT, symbol: 'ETH/USDT', capturedAt: NOW,
      source: 'gateio-live-read:capture-1', positionMode: dual ? 'dual' : 'single',
      legs: (dual ? ['dual_long', 'dual_short'] : ['single']).map(mode =>
        ({ contract: 'ETH_USDT', mode, size: 0, value: 0 })),
    })).digest('hex'));
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').status, 'flat');
    assert.equal(h.journal.eventCount, 1);
    assert.throws(() => establishVerifiedLiveFlatBaseline(h.baseline), /BASELINE_DENIED/);
    assert.equal(h.journal.eventCount, 1);
    assert.equal(h.requests.length, calls); // Bootstrap itself performs no reads or mutations.
    assert.equal(h.spine.recoveryVerified, false);
    assert.equal(h.spine.reconciliationVerified, false);
  });

  for (const [name, setup] of [
    ['nonflat', { exposure: 0.1 }], ['unknown', { unknown: true }], ['open order', { openOrder: true }],
    ['no ETH legs', { positions: [] }], ['TestNet cannot use LIVE helper', { environment: 'testnet' }],
  ] as const) it(`${name}: no baseline/journal`, async () => {
    const h = await harness(setup);
    assert.throws(() => bootstrapGateIoLiveJournal(h.input), /BASELINE_DENIED/);
    assert.equal(h.journal.eventCount, 0);
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').status, 'missing');
    assert.equal(existsSync(h.journalPath), false);
  });

  it('wrong account and wrong symbol denied', async () => {
    const h = await harness();
    assert.throws(() => establishVerifiedLiveFlatBaseline({ ...h.baseline, accountId: 'other' }), /BASELINE_DENIED/);
    assert.throws(() => establishVerifiedLiveFlatBaseline({ ...h.baseline, symbol: 'BTC/USDT' }), /BASELINE_DENIED/);
    assert.equal(h.journal.eventCount, 0);
  });
  for (const age of [-1, 30_001, NaN, Infinity]) it(`invalid/stale local clock ${age} denied`, async () => {
    const h = await harness(); h.setTime(NOW + age);
    assert.throws(() => establishVerifiedLiveFlatBaseline(h.baseline), /BASELINE_DENIED/);
  });
  it('30s boundary is accepted; old canonical observation cannot be made fresh by capture time', async () => {
    const h = await harness(); h.setTime(NOW + 30_000);
    establishVerifiedLiveFlatBaseline(h.baseline);
    const stale = await harness({ transformAccount: a => ({ ...a, observedAtMs: NOW - 30_001 }) });
    assert.equal(stale.truth.complete, true);
    assert.throws(() => establishVerifiedLiveFlatBaseline(stale.baseline), /BASELINE_DENIED/);
  });
  for (const source of ['xgateio-live-read:capture-1', 'gateio-testnet-read:capture-1',
    'gateio-live-read:capture-01', 'gateio-live-read:capture-1:extra', 'gateio-live-read:capture-2'])
    it(`wrong exact source ${source} denied`, async () => {
      const h = await harness();
      assert.throws(() => establishVerifiedLiveFlatBaseline({ ...h.baseline, truth: { ...h.truth, source } }), /BASELINE_DENIED/);
    });
  it('a structural fake truth port cannot mint baseline provenance', async () => {
    const h = await harness();
    assert.throws(() => establishVerifiedLiveFlatBaseline({ ...h.baseline,
      truthPort: { ...h.port, isLatestTruth: () => true } }), /BASELINE_DENIED/);
  });
  it('non-latest and cloned latest capture denied', async () => {
    const h = await harness();
    assert.throws(() => establishVerifiedLiveFlatBaseline({ ...h.baseline, truth: { ...h.truth } }), /BASELINE_DENIED/);
    await h.port.acquireTruth();
    assert.throws(() => establishVerifiedLiveFlatBaseline(h.baseline), /BASELINE_DENIED/);
  });
  for (const [name, transformAccount] of Object.entries({
    missingMode: (a: GateIoCanonicalAccountTruth) => ({ ...a, account: { ...a.account, inDualMode: null } }),
    noLeg: (a: GateIoCanonicalAccountTruth) => ({ ...a, positions: [] }),
    twoSingleLegs: (a: GateIoCanonicalAccountTruth) => ({ ...a, positions: [...a.positions, ...a.positions] }),
    missingDualLeg: (a: GateIoCanonicalAccountTruth) => ({ ...a, positions: a.positions.slice(0, 1) }),
    duplicateDualLeg: (a: GateIoCanonicalAccountTruth) => ({ ...a, positions: [a.positions[0]!, a.positions[0]!] }),
    foreignLeg: (a: GateIoCanonicalAccountTruth) => ({ ...a, positions: a.positions.map(p => ({ ...p, contract: 'BTC_USDT' as any })) }),
    wrongSettle: (a: GateIoCanonicalAccountTruth) => ({ ...a, identity: { ...a.identity, settle: 'BTC' as any } }),
    unknownZero: (a: GateIoCanonicalAccountTruth) => ({ ...a, positions: a.positions.map(p => ({ ...p, quoteValue: null as any })) }),
    nonzeroValue: (a: GateIoCanonicalAccountTruth) => ({ ...a, positions: a.positions.map(p => ({ ...p, quoteValue: 0.2 })) }),
  })) it(`canonical ${name} fail closed despite FLAT label`, async () => {
    const h = await harness({ dual: name.includes('Dual'), transformAccount });
    assert.throws(() => establishVerifiedLiveFlatBaseline(h.baseline), /BASELINE_DENIED/);
    assert.equal(h.journal.eventCount, 0);
  });
  it('existing local position denies even if journal is empty', async () => {
    const h = await harness();
    h.spine.positionStore.apply({ type: 'position.baseline.confirmed', kernelLogicalSequence: 1,
      kernelEventId: 'a'.repeat(64), kernelTimestamp: NOW, payload: { baseline: {
        exchange: 'gateio', symbol: 'ETH/USDT', side: 'flat', signedQuantity: 0, averageEntryPrice: 0 } } } as any);
    assert.equal(h.journal.eventCount, 0);
    assert.throws(() => establishVerifiedLiveFlatBaseline(h.baseline), /BASELINE_DENIED/);
  });
  it('nonempty local OMS after acquisition denies without publishing', async () => {
    const h = await harness();
    h.spine.oms.getStore().apply({ type: 'order.created', kernelLogicalSequence: 1,
      kernelEventId: 'a'.repeat(64), payload: { order: { orderId: 'existing' } } } as any);
    assert.throws(() => establishVerifiedLiveFlatBaseline(h.baseline), /BASELINE_DENIED/);
    assert.equal(h.journal.eventCount, 0);
  });
  it('existing historical boundary and later external activity remain fail closed', async () => {
    const h = await harness(); bootstrapGateIoLiveJournal(h.input);
    assert.equal((await h.port.acquireTruth()).complete, true);
    h.addExternalTrade();
    assert.equal((await h.port.acquireTruth()).complete, false);
    const altered = await harness(); bootstrapGateIoLiveJournal(altered.input);
    altered.changeHistoricalTrade();
    assert.equal((await altered.port.acquireTruth()).complete, false);
  });
  it('TestNet helper still works unchanged and still refuses LIVE', async () => {
    const testnet = await harness({ environment: 'testnet' });
    establishVerifiedExternalFlatBaseline(testnet.baseline);
    const live = await harness();
    assert.throws(() => establishVerifiedExternalFlatBaseline(live.baseline), /VERIFIED_FLAT_BASELINE_DENIED/);
  });
});

describe('Gate G8A explicit policy and durable one-shot journal', () => {
  it('two real Kernel events only; integrity reopen and RecoveryManager replay actual canonical stores', async () => {
    const h = await harness();
    const receipt = bootstrapGateIoLiveJournal(h.input);
    assert.equal(receipt.eventCount, 2); assert.equal(receipt.integrityVerified, true);
    assert.equal(receipt.policySynthesized, false); assert.equal(receipt.liveReady, false);
    assert.equal(receipt.executionAuthority, false);
    const reopened = createFileEventJournal(h.journalPath);
    const events = reopened.readFromLogicalSequence(1);
    assert.deepEqual(events.map(e => e.type), ['position.baseline.confirmed', 'policy.snapshot.published']);
    assert.deepEqual(events[1]!.payload, { policy: h.input.policy });
    const positions = createKernelPositionStateStore();
    const policies = createKernelPolicyStore({ clock: { now: () => NOW }, maxLifetimeMs: LIFETIME, maxVersionsPerExchange: 10 });
    const projectors: ProjectorMap = new Map([
      ['position.baseline.confirmed', [positions]], ['policy.snapshot.published', [policies]],
    ]);
    const recovered = recoverFromJournal(reopened, projectors);
    assert.equal(recovered.recoveryVerified, true); assert.equal(recovered.replayReport.eventsReplayed, 2);
    assert.equal(positions.resolve('gateio', 'ETH/USDT').status, 'flat');
    assert.equal(policies.resolve('gateio', 'ETH/USDT').status, 'active');
    assert.equal(policies.resolve('gateio', 'ETH/USDT').allowNewEntries, true);
    assert.equal(h.spine.oms.getStore().list().length, 0);
    assert.equal(h.spine.recoveryVerified, false); // This helper does not arm the Spine.
    assert.equal(h.spine.reconciliationVerified, false);
    assert.throws(() => bootstrapGateIoLiveJournal(h.input), /JOURNAL_DENIED/);
    assert.equal(createFileEventJournal(h.journalPath).eventCount, 2);
    for (const forbidden of ['G8A_OFFLINE_FIXTURE_KEY', 'G8A_OFFLINE_FIXTURE_SECRET', 'SIGN', 'order.created', 'execution.fill.confirmed'])
      assert.equal(readFileSync(h.journalPath, 'utf8').includes(forbidden), false);
  });
  for (const [name, patch] of Object.entries({
    missing: null, invalid: {}, wrongExchange: { exchange: 'binance' }, expired: { expiresAt: NOW },
    future: { effectiveAt: NOW + 1 }, denied: { allowNewEntries: false }, zero: { maxPositionMultiplier: 0 },
    nan: { maxPositionMultiplier: NaN }, infinity: { maxPositionMultiplier: Infinity },
    wrongScope: { allowedSymbols: ['BTC/USDT'] }, blockedScope: { allowedSymbols: [], blockedSymbols: ['ETH/USDT'] },
    incompatibleResearchSequence: { sourceResearchSequence: 2 },
    malformedResearchId: { sourceResearchEventId: 'fake' },
    symbolRuleDenied: { symbolRules: { 'ETH/USDT': { allowNewEntries: false, maxPositionMultiplier: 1,
      directionBias: 'neutral', riskLevel: 'low', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] } } },
    symbolRuleZero: { symbolRules: { 'ETH/USDT': { allowNewEntries: true, maxPositionMultiplier: 0,
      directionBias: 'neutral', riskLevel: 'low', allowedStrategyIds: [], blockedStrategyIds: [], reasonCodes: [] } } },
  })) it(`policy ${name} rejected BEFORE baseline/file write`, async () => {
    const h = await harness();
    const policy = name === 'missing' ? undefined : name === 'invalid' ? patch : { ...h.input.policy, ...patch };
    assert.throws(() => bootstrapGateIoLiveJournal({ ...h.input, policy: policy as CompiledPolicy }), /POLICY_DENIED/);
    assert.equal(h.journal.eventCount, 0); assert.equal(existsSync(h.journalPath), false);
    assert.equal(h.spine.positionStore.resolve('gateio', 'ETH/USDT').status, 'missing');
  });
  it('existing empty explicit file accepted, relative/mismatched paths denied', async () => {
    const h = await harness();
    assert.throws(() => bootstrapGateIoLiveJournal({ ...h.input, journalPath: 'relative.jsonl' }), /JOURNAL_DENIED/);
    assert.throws(() => bootstrapGateIoLiveJournal({ ...h.input, journalPath: h.journalPath + '.other' }), /JOURNAL_DENIED/);
    writeFileSync(h.journalPath, '');
    bootstrapGateIoLiveJournal(h.input);
    assert.equal(createFileEventJournal(h.journalPath).eventCount, 2);
  });
  it('nonempty on-disk journal cannot hide behind empty cached journal', async () => {
    const h = await harness(); writeFileSync(h.journalPath, 'unrelated-existing-data');
    assert.throws(() => bootstrapGateIoLiveJournal(h.input), /JOURNAL_DENIED/);
    assert.equal(readFileSync(h.journalPath, 'utf8'), 'unrelated-existing-data');
  });
  it('nonempty Kernel journal rejects baseline and bootstrap', async () => {
    const h = await harness();
    h.spine.kernel.publish('market.ticker.updated', { ticker: { channel: 'ticker', exchange: 'gateio',
      instId: 'ETH/USDT', last: 2000, bestBid: 1999, bestAsk: 2001, volume24h: 1, high24h: 2100, low24h: 1900, ts: NOW },
      receivedAt: NOW });
    assert.throws(() => establishVerifiedLiveFlatBaseline(h.baseline), /BASELINE_DENIED/);
    assert.throws(() => bootstrapGateIoLiveJournal(h.input), /JOURNAL_DENIED/);
    assert.equal(h.journal.eventCount, 1);
  });
  it('publication failure stops, preserves partial evidence, never retries or activates', async () => {
    const h = await harness();
    h.spine.kernel.subscribe('policy.snapshot.published', () => { throw new Error('fixture projection failure'); });
    assert.throws(() => bootstrapGateIoLiveJournal(h.input), /POLICY_NOT_APPLIED/);
    assert.equal(h.journal.eventCount, 2);
    assert.throws(() => bootstrapGateIoLiveJournal(h.input), /JOURNAL_DENIED/);
    assert.equal(h.spine.reconciliationVerified, false);
  });
  it('Kernel still enforces its own policy validator; no bypass on configuration mismatch', async () => {
    const h = await harness({ kernelPolicyLifetime: 1000 });
    assert.throws(() => bootstrapGateIoLiveJournal(h.input), /POLICY_INVALID/);
    assert.equal(h.journal.eventCount, 1);
    assert.equal(h.spine.policyStore.resolve('gateio', 'ETH/USDT').status, 'missing');
    assert.throws(() => bootstrapGateIoLiveJournal(h.input), /JOURNAL_DENIED/);
  });
  it('disk corruption during publication cannot produce an integrity-verified receipt', async () => {
    const h = await harness();
    h.spine.kernel.subscribe('policy.snapshot.published', () => {
      const lines = readFileSync(h.journalPath, 'utf8').trim().split('\n');
      const entry = JSON.parse(lines[0]!); entry.checksum = '0'.repeat(64);
      writeFileSync(h.journalPath, JSON.stringify(entry) + '\n' + lines[1] + '\n');
    });
    assert.throws(() => bootstrapGateIoLiveJournal(h.input), /JOURNAL_CHECKSUM_MISMATCH/);
  });
  it('digest changes with account, capture time, position mode, and binds exact canonical legs', async () => {
    const h = await harness(), other = await harness({ accountId: 'different-account' }), dual = await harness({ dual: true });
    const later = await harness({ initialTime: NOW + 1 });
    const d = verifyGateIoLiveFlatBaseline(h.baseline).digest;
    assert.notEqual(d, verifyGateIoLiveFlatBaseline(other.baseline).digest);
    assert.notEqual(d, verifyGateIoLiveFlatBaseline(dual.baseline).digest);
    assert.notEqual(d, verifyGateIoLiveFlatBaseline(later.baseline).digest);
    assert.equal(h.journal.eventCount, 0); // Checking a digest never publishes a baseline.
  });
});
