// Phase 1B2: Policy Snapshot Validation — pure, shared, pre-journal validation
import type { ExchangeId } from '../data/MarketIdentity';
import type { CompiledPolicy } from '../types/policy-snapshot';

const SHA_RE = /^[0-9a-f]{64}$/;
const DIRECTION_SET = new Set(['bullish', 'bearish', 'neutral', 'mixed']);
const RISK_LEVEL_SET = new Set(['low', 'medium', 'high']);

// ─── Helpers ────────────────────────────────────────────────────────────────

function isFiniteSafeInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && Number.isFinite(v);
}

function isNonNegativeSafeInteger(v: unknown): v is number {
  return isFiniteSafeInteger(v) && v >= 0;
}

function isPositiveSafeInteger(v: unknown): v is number {
  return isFiniteSafeInteger(v) && v > 0;
}

function isNonEmptyTrimmed(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0 && s === s.trim();
}

function assertUniqueSorted(arr: readonly string[], name: string): void {
  const set = new Set<string>();
  for (const item of arr) {
    if (!isNonEmptyTrimmed(item)) {
      throw new Error(`POLICY_INVALID: ${name} contains empty or non-trimmed string`);
    }
    if (set.has(item)) {
      throw new Error(`POLICY_INVALID: duplicate in ${name}: ${item}`);
    }
    set.add(item);
  }
  // lexicographically sorted
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < arr[i - 1]) {
      throw new Error(`POLICY_INVALID: ${name} not sorted`);
    }
  }
}

function assertNoIntersection(a: readonly string[], b: readonly string[], aName: string, bName: string): void {
  const bSet = new Set(b);
  for (const item of a) {
    if (bSet.has(item)) {
      throw new Error(`POLICY_INVALID: ${item} in both ${aName} and ${bName}`);
    }
  }
}

function assertFiniteRange(v: unknown, name: string, min: number, max: number): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`POLICY_INVALID: ${name}=${v}, must be in [${min},${max}]`);
  }
}

function assertJsonSafe(obj: unknown, path: string, seen: WeakSet<object>): void {
  if (obj === null || obj === undefined) {
    if (obj === undefined) throw new Error(`POLICY_INVALID: undefined at ${path}`);
    return;
  }
  const t = typeof obj;
  if (t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new Error(`POLICY_INVALID: ${t} at ${path}`);
  }
  if (t === 'number' && !Number.isFinite(obj as number)) {
    throw new Error(`POLICY_INVALID: non-finite number at ${path}`);
  }
  if (t === 'object') {
    if (seen.has(obj as object)) {
      throw new Error(`POLICY_INVALID: cycle at ${path}`);
    }
    seen.add(obj as object);
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        assertJsonSafe(obj[i], `${path}[${i}]`, seen);
      }
    } else {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        assertJsonSafe(v, `${path}.${k}`, seen);
      }
    }
  }
}

// ─── Main validation — called BEFORE journal append ─────────────────────────

export function validatePolicyPublication(
  policy: CompiledPolicy,
  candidateSeq: number,
  kernelTimestamp: number,
  maxLifetimeMs: number,
): void {
  // Structural: must be object
  if (!policy || typeof policy !== 'object') {
    throw new Error('POLICY_INVALID: missing policy');
  }

  // Exchange
  if (!isNonEmptyTrimmed(policy.exchange)) {
    throw new Error('POLICY_INVALID: exchange');
  }

  // Timestamps
  if (!isNonNegativeSafeInteger(policy.compiledAt)) throw new Error('POLICY_INVALID: compiledAt');
  if (!isNonNegativeSafeInteger(policy.effectiveAt)) throw new Error('POLICY_INVALID: effectiveAt');
  if (!isPositiveSafeInteger(policy.expiresAt)) throw new Error('POLICY_INVALID: expiresAt');

  // Source
  if (typeof policy.sourceResearchEventId !== 'string' || !SHA_RE.test(policy.sourceResearchEventId)) {
    throw new Error('POLICY_INVALID: sourceResearchEventId must be 64-char hex');
  }
  if (!isNonNegativeSafeInteger(policy.sourceResearchSequence)) throw new Error('POLICY_INVALID: sourceResearchSequence');
  if (policy.sourceResearchSequence >= candidateSeq) {
    throw new Error(`POLICY_INVALID: sourceResearchSequence=${policy.sourceResearchSequence} >= publication seq=${candidateSeq}`);
  }
  if (!isNonEmptyTrimmed(policy.compilerVersion)) throw new Error('POLICY_INVALID: compilerVersion');

  // Time ordering
  if (policy.compiledAt > policy.effectiveAt) throw new Error('POLICY_INVALID: compiledAt > effectiveAt');
  if (policy.effectiveAt > kernelTimestamp) throw new Error('POLICY_INVALID: effectiveAt > kernelTimestamp');
  if (policy.expiresAt <= policy.effectiveAt) throw new Error('POLICY_INVALID: expiresAt <= effectiveAt');

  // degradeUntil
  if (policy.degradeUntil !== undefined) {
    if (!isNonNegativeSafeInteger(policy.degradeUntil) || policy.degradeUntil < policy.expiresAt) {
      throw new Error('POLICY_INVALID: degradeUntil < expiresAt');
    }
  }

  // Lifetime
  const lifetime = (policy.degradeUntil ?? policy.expiresAt) - policy.effectiveAt;
  if (lifetime > maxLifetimeMs) {
    throw new Error(`POLICY_INVALID: lifetime ${lifetime}ms > max ${maxLifetimeMs}ms`);
  }

  // Multiplier
  assertFiniteRange(policy.maxPositionMultiplier, 'maxPositionMultiplier', 0, 1);

  // Enums
  if (typeof policy.directionBias !== 'string' || !DIRECTION_SET.has(policy.directionBias)) {
    throw new Error(`POLICY_INVALID: directionBias=${policy.directionBias}`);
  }
  if (typeof policy.riskLevel !== 'string' || !RISK_LEVEL_SET.has(policy.riskLevel)) {
    throw new Error(`POLICY_INVALID: riskLevel=${policy.riskLevel}`);
  }

  // allowNewEntries boolean
  if (typeof policy.allowNewEntries !== 'boolean') throw new Error('POLICY_INVALID: allowNewEntries');

  // Symbol lists
  assertUniqueSorted(policy.allowedSymbols, 'allowedSymbols');
  assertUniqueSorted(policy.blockedSymbols, 'blockedSymbols');
  assertNoIntersection(policy.allowedSymbols, policy.blockedSymbols, 'allowedSymbols', 'blockedSymbols');

  // Strategy lists
  assertUniqueSorted(policy.allowedStrategyIds, 'allowedStrategyIds');
  assertUniqueSorted(policy.blockedStrategyIds, 'blockedStrategyIds');
  assertNoIntersection(policy.allowedStrategyIds, policy.blockedStrategyIds, 'allowedStrategyIds', 'blockedStrategyIds');

  // reasonCodes
  assertUniqueSorted(policy.reasonCodes, 'reasonCodes');

  // Symbol rules
  if (policy.symbolRules && typeof policy.symbolRules === 'object') {
    const ruleKeys = Object.keys(policy.symbolRules).sort();
    for (let i = 0; i < ruleKeys.length; i++) {
      const sym = ruleKeys[i];
      if (!isNonEmptyTrimmed(sym)) throw new Error(`POLICY_INVALID: symbolRules key empty`);
      const rule = policy.symbolRules[sym];
      if (!rule || typeof rule !== 'object') throw new Error(`POLICY_INVALID: symbolRules.${sym} missing`);

      if (typeof rule.allowNewEntries !== 'boolean') throw new Error(`POLICY_INVALID: symbolRules.${sym}.allowNewEntries`);
      assertFiniteRange(rule.maxPositionMultiplier, `symbolRules.${sym}.maxPositionMultiplier`, 0, 1);
      if (typeof rule.directionBias !== 'string' || !DIRECTION_SET.has(rule.directionBias)) {
        throw new Error(`POLICY_INVALID: symbolRules.${sym}.directionBias`);
      }
      if (typeof rule.riskLevel !== 'string' || !RISK_LEVEL_SET.has(rule.riskLevel)) {
        throw new Error(`POLICY_INVALID: symbolRules.${sym}.riskLevel`);
      }
      assertUniqueSorted(rule.allowedStrategyIds, `symbolRules.${sym}.allowedStrategyIds`);
      assertUniqueSorted(rule.blockedStrategyIds, `symbolRules.${sym}.blockedStrategyIds`);
      assertNoIntersection(rule.allowedStrategyIds, rule.blockedStrategyIds,
        `symbolRules.${sym}.allowedStrategyIds`, `symbolRules.${sym}.blockedStrategyIds`);
      assertUniqueSorted(rule.reasonCodes, `symbolRules.${sym}.reasonCodes`);
    }
  }

  // JSON safety
  assertJsonSafe(policy, 'policy', new WeakSet());
}
