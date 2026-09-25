/** G3 TestNet composition only. Secrets and Git state are supplied by a separate local launcher. */
import type { MarketSnapshot } from '../../data/MarketSnapshot';
import type { EventJournalPort } from '../../kernel/EventJournalPort';
import type { AccountBoundHardRiskSnapshot } from '../../risk/pretrade-risk-types';
import type { PolicyResolution } from '../../types/policy-snapshot';
import type { GateIoReadCredential } from './GateIoReadContracts';
import { GATEIO_L0_TESTNET_ORIGIN } from './GateIoReadContracts';
import type { GateIoReadFetch } from './GateIoReadTransport';
import { GATEIO_G3_LIMITS, GateIoG3RunBudget } from './GateIoG3RunBudget';
import { createGateIoTestnetOmsE2ERunner, type GateIoG3FactualRiskInput,
  type GateIoG3RunReceipt } from './GateIoTestnetOmsE2ERunner';

export const GATEIO_G3_PROOF_POLICY_SOURCE = 'G3_TESTNET_PROOF_POLICY' as const;
const MAX_FACT_AGE_MS = 30_000;
const EXACT_HEAD = /^[a-f0-9]{40}$/;

export interface GateIoG3LaunchOptions {
  readonly credential: GateIoReadCredential;
  readonly accountId: string;
  readonly fetchImpl: GateIoReadFetch;
  readonly now: () => number;
  readonly journal: EventJournalPort;
  /** External launcher supplies Git evidence; the trading core never invokes Git. */
  readonly expectedExactHead: string;
  readonly actualExactHead: () => string;
  readonly worktreeClean: () => boolean;
}

export interface GateIoG3LaunchResult {
  readonly exactHead: string;
  readonly receipt: GateIoG3RunReceipt;
  readonly proofPolicySource: typeof GATEIO_G3_PROOF_POLICY_SOURCE;
  readonly marketFacts: Readonly<{
    markPrice: number;
    contractMultiplier: number;
    minOrderSize: number;
    maxOrderSize: number;
    decimalSizeEnabled: boolean;
    observedAtMs: number;
  }> | null;
  readonly usableCapitalUsd: number | null;
  readonly sharedBudgetIdentityVerified: true;
  readonly liveReady: false;
}

export interface GateIoG3LaunchBinding {
  readonly sharedBudget: GateIoG3RunBudget;
  run(): Promise<GateIoG3LaunchResult>;
}

function fail(reason: string): never { throw new Error(reason); }

function factualInputValid(input: GateIoG3FactualRiskInput): boolean {
  const { account, instrument, nowMs } = input;
  return account.identity.exchange === 'gateio'
    && account.identity.settle === 'USDT'
    && account.freshness === 'FRESH' && instrument.freshness === 'FRESH'
    && instrument.contract === 'ETH_USDT' && instrument.contractOpenable
    && !instrument.inDelisting
    && Number.isSafeInteger(nowMs)
    && nowMs >= account.observedAtMs && nowMs - account.observedAtMs <= MAX_FACT_AGE_MS
    && nowMs >= instrument.observedAtMs && nowMs - instrument.observedAtMs <= MAX_FACT_AGE_MS
    && Number.isFinite(instrument.markPrice) && instrument.markPrice > 0
    && Number.isFinite(instrument.lastPrice) && instrument.lastPrice > 0
    && Number.isFinite(instrument.contractMultiplier) && instrument.contractMultiplier > 0
    && Number.isFinite(instrument.minOrderSize) && instrument.minOrderSize > 0
    && Number.isFinite(instrument.maxOrderSize)
    && instrument.maxOrderSize >= instrument.minOrderSize;
}

/** Project only observed Gate ticker fields; sizing separately uses factual mark. */
export function gateIoG3FactualMarketSnapshot(input: GateIoG3FactualRiskInput): MarketSnapshot {
  if (!factualInputValid(input)) fail('GATEIO_G3_MARKET_FACTS_UNAVAILABLE');
  const { instrument: facts, nowMs } = input;
  const { bestBid, bestAsk, volume24h, high24h, low24h } = facts;
  if (typeof bestBid !== 'number' || !Number.isFinite(bestBid) || bestBid <= 0
      || typeof bestAsk !== 'number' || !Number.isFinite(bestAsk) || bestAsk <= 0
      || bestBid > bestAsk
      || typeof volume24h !== 'number' || !Number.isFinite(volume24h) || volume24h < 0
      || typeof high24h !== 'number' || !Number.isFinite(high24h) || high24h <= 0
      || typeof low24h !== 'number' || !Number.isFinite(low24h) || low24h <= 0
      || high24h < low24h || !Number.isSafeInteger(facts.serverTimeMs)
      || facts.serverTimeMs <= 0) fail('GATEIO_G3_MARKET_FACTS_UNAVAILABLE');
  return Object.freeze({
    exchange: 'gateio' as const, symbol: 'ETH/USDT',
    ticker: Object.freeze({
      receivedAt: facts.observedAtMs,
      ticker: Object.freeze({
        channel: 'ticker' as const, exchange: 'gateio' as const, instId: 'ETH/USDT',
        last: facts.lastPrice, bestBid, bestAsk, volume24h, high24h, low24h,
        ts: facts.serverTimeMs,
      }),
    }),
    klines: Object.freeze({}), snapshotVersion: 1,
    generatedAt: facts.observedAtMs, lastUpdatedAt: facts.observedAtMs,
    ageMs: nowMs - facts.observedAtMs, isStale: false,
  });
}

export function gateIoG3FactualHardRisk(
  input: GateIoG3FactualRiskInput, accountId: string,
): AccountBoundHardRiskSnapshot {
  if (!factualInputValid(input) || input.account.identity.accountId !== accountId)
    fail('GATEIO_G3_ACCOUNT_FACTS_UNAVAILABLE');
  const capital = Math.min(input.account.account.available, input.account.account.total);
  const facts = input.instrument;
  const minimumNotional = facts.markPrice * facts.contractMultiplier * facts.minOrderSize;
  if (!Number.isFinite(capital) || capital <= 0 || !Number.isFinite(minimumNotional)
      || minimumNotional <= 0) fail('GATEIO_G3_ACCOUNT_FACTS_UNAVAILABLE');
  if (capital < minimumNotional) fail('GATEIO_G3_CAPITAL_INSUFFICIENT');
  return Object.freeze({
    exchange: 'gateio' as const, accountId, locked: false, enabled: true,
    totalCapitalUsd: capital, maxSinglePositionPct: 1,
    maxSinglePositionAbsUsd: minimumNotional,
  });
}

const PROOF_POLICY: PolicyResolution & { readonly source: typeof GATEIO_G3_PROOF_POLICY_SOURCE } =
  Object.freeze({
    source: GATEIO_G3_PROOF_POLICY_SOURCE,
    status: 'active', policy: null, allowNewEntries: true,
    maxPositionMultiplier: 1, directionBias: 'neutral',
    riskLevel: 'low', allowedStrategyIds: Object.freeze([]),
    blockedStrategyIds: Object.freeze([]),
    reasonCodes: Object.freeze([GATEIO_G3_PROOF_POLICY_SOURCE]),
  });

export function createGateIoTestnetOmsE2ELaunchBinding(
  options: GateIoG3LaunchOptions,
): GateIoG3LaunchBinding {
  if (!options || typeof options.accountId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(options.accountId)
      || !options.credential || typeof options.credential.apiKey !== 'string'
      || typeof options.credential.secretKey !== 'string'
      || options.credential.apiKey.trim().length === 0
      || options.credential.secretKey.trim().length === 0
      || options.credential.apiKey.length > 512 || options.credential.secretKey.length > 512
      || typeof options.fetchImpl !== 'function' || typeof options.now !== 'function'
      || !options.journal || typeof options.journal.append !== 'function'
      || typeof options.journal.readFromLogicalSequence !== 'function'
      || !EXACT_HEAD.test(options.expectedExactHead)
      || typeof options.actualExactHead !== 'function'
      || typeof options.worktreeClean !== 'function')
    fail('GATEIO_G3_LAUNCH_CONFIGURATION_INVALID');

  const budget = GateIoG3RunBudget.create(GATEIO_G3_LIMITS);
  let marketFacts: GateIoG3LaunchResult['marketFacts'] = null;
  let usableCapitalUsd: number | null = null;
  let started = false;
  const lockedFetch: GateIoReadFetch = async (url, init) => {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { fail('GATEIO_G3_TESTNET_HOST_DENIED'); }
    if (parsed.origin !== GATEIO_L0_TESTNET_ORIGIN || parsed.username || parsed.password)
      fail('GATEIO_G3_TESTNET_HOST_DENIED');
    return options.fetchImpl(url, init);
  };
  return Object.freeze({
    sharedBudget: budget,
    async run(): Promise<GateIoG3LaunchResult> {
      if (started) fail('GATEIO_G3_LAUNCH_ALREADY_STARTED');
      started = true;
      // No transport, secret read or mutation occurs before these external Git checks.
      if (options.actualExactHead() !== options.expectedExactHead
          || !options.worktreeClean()) fail('GATEIO_G3_EXACT_HEAD_PREFLIGHT_FAILED');
      const runner = createGateIoTestnetOmsE2ERunner({
        environment: 'testnet', credential: options.credential,
        accountId: options.accountId, readFetch: lockedFetch,
        executionFetch: lockedFetch, now: options.now, journal: options.journal,
        runBudget: budget,
        marketSnapshot: (input) => {
          const market = gateIoG3FactualMarketSnapshot(input);
          const facts = input.instrument;
          marketFacts = Object.freeze({
            markPrice: facts.markPrice, contractMultiplier: facts.contractMultiplier,
            minOrderSize: facts.minOrderSize, maxOrderSize: facts.maxOrderSize,
            decimalSizeEnabled: facts.decimalSizeEnabled,
            observedAtMs: facts.observedAtMs,
          });
          return market;
        },
        policyResolution: () => PROOF_POLICY,
        hardRisk: (input) => {
          const hardRisk = gateIoG3FactualHardRisk(input, options.accountId);
          usableCapitalUsd = hardRisk.totalCapitalUsd;
          return hardRisk;
        },
      });
      if (runner.sharedBudget !== budget) fail('GATEIO_G3_SHARED_BUDGET_MISMATCH');
      const receipt = await runner.run();
      return Object.freeze({
        exactHead: options.expectedExactHead, receipt,
        proofPolicySource: GATEIO_G3_PROOF_POLICY_SOURCE,
        marketFacts, usableCapitalUsd,
        sharedBudgetIdentityVerified: true as const, liveReady: false as const,
      });
    },
  });
}
