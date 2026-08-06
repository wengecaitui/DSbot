// Phase 1B2: Policy Snapshot Validation — pure, shared, pre-journal validation
import { isExchangeId } from '../data/MarketIdentity';

const SHA_RE = /^[0-9a-f]{64}$/;
const DIRECTION_SET = new Set(['bullish', 'bearish', 'neutral', 'mixed']);
const RISK_LEVEL_SET = new Set(['low', 'medium', 'high']);

const COMPILED_POLICY_KEYS = new Set([
  'exchange', 'sourceResearchEventId', 'sourceResearchSequence', 'compilerVersion',
  'compiledAt', 'effectiveAt', 'expiresAt', 'degradeUntil',
  'allowNewEntries', 'allowedSymbols', 'blockedSymbols',
  'allowedStrategyIds', 'blockedStrategyIds',
  'maxPositionMultiplier', 'riskLevel', 'directionBias',
  'symbolRules', 'reasonCodes',
]);

const SYMBOL_RULE_KEYS = new Set([
  'allowNewEntries', 'maxPositionMultiplier', 'directionBias', 'riskLevel',
  'allowedStrategyIds', 'blockedStrategyIds', 'reasonCodes',
]);

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

function assertUniqueSorted(arr: unknown, name: string): void {
  if (!Array.isArray(arr)) throw new Error(`POLICY_INVALID: ${name} is not an array`);
  const a = arr as readonly string[];
  const set = new Set<string>();
  for (const item of a) {
    if (!isNonEmptyTrimmed(item)) {
      throw new Error(`POLICY_INVALID: ${name} contains empty or non-trimmed string`);
    }
    if (set.has(item)) {
      throw new Error(`POLICY_INVALID: duplicate in ${name}: ${item}`);
    }
    set.add(item);
  }
  for (let i = 1; i < a.length; i++) {
    if (a[i] < a[i - 1]) throw new Error(`POLICY_INVALID: ${name} not sorted`);
  }
}

function assertNoIntersection(a: readonly string[], b: readonly string[], aName: string, bName: string): void {
  const bSet = new Set(b);
  for (const item of a) {
    if (bSet.has(item)) throw new Error(`POLICY_INVALID: ${item} in both ${aName} and ${bName}`);
  }
}

function assertFiniteRange(v: unknown, name: string, min: number, max: number): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`POLICY_INVALID: ${name}=${v}, must be in [${min},${max}]`);
  }
}

function assertJsonSafe(obj: unknown, path: string, seen: WeakSet<object>): void {
  if (obj === null) return;
  if (obj === undefined) throw new Error(`POLICY_INVALID: undefined at ${path}`);
  const t = typeof obj;
  if (t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new Error(`POLICY_INVALID: ${t} at ${path}`);
  }
  if (t === 'number' && !Number.isFinite(obj as number)) {
    throw new Error(`POLICY_INVALID: non-finite number at ${path}`);
  }
  if (t === 'object') {
    // Allow shared non-cyclic references (no cycle check)
    seen.add(obj as object);
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (!seen.has(obj[i] as object)) assertJsonSafe(obj[i], `${path}[${i}]`, seen);
      }
    } else {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (!seen.has(v as object)) assertJsonSafe(v, `${path}.${k}`, seen);
      }
    }
  }
}

// ─── Main validation — called BEFORE journal append ─────────────────────────

export function validatePolicyPublication(
  policy: unknown,
  candidateSeq: number,
  kernelTimestamp: number,
  maxLifetimeMs: number,
): void {
  // Validate publication metadata
  if (!isPositiveSafeInteger(candidateSeq)) throw new Error('POLICY_INVALID: candidateSeq');
  if (!isNonNegativeSafeInteger(kernelTimestamp)) throw new Error('POLICY_INVALID: kernelTimestamp');
  if (!isPositiveSafeInteger(maxLifetimeMs)) throw new Error('POLICY_INVALID: maxLifetimeMs');

  // Structural
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('POLICY_INVALID: missing policy');
  }

  const p = policy as Record<string, unknown>;

  // Strict schema: reject unknown fields
  for (const key of Object.keys(p)) {
    if (!COMPILED_POLICY_KEYS.has(key)) {
      throw new Error(`POLICY_INVALID: unknown field "${key}"`);
    }
  }
  // Require every mandatory key
  for (const key of COMPILED_POLICY_KEYS) {
    if (key === 'degradeUntil') continue; // optional
    if (!(key in p)) throw new Error(`POLICY_INVALID: missing required field "${key}"`);
  }

  // Exchange with isExchangeId
  if (!isNonEmptyTrimmed(p.exchange)) throw new Error('POLICY_INVALID: exchange');
  if (!isExchangeId(p.exchange as string)) throw new Error(`POLICY_INVALID: exchange=${p.exchange}`);

  // Timestamps
  if (!isNonNegativeSafeInteger(p.compiledAt)) throw new Error('POLICY_INVALID: compiledAt');
  if (!isNonNegativeSafeInteger(p.effectiveAt)) throw new Error('POLICY_INVALID: effectiveAt');
  if (!isPositiveSafeInteger(p.expiresAt)) throw new Error('POLICY_INVALID: expiresAt');

  // Source — positive safe integer
  if (typeof p.sourceResearchEventId !== 'string' || !SHA_RE.test(p.sourceResearchEventId)) {
    throw new Error('POLICY_INVALID: sourceResearchEventId must be 64-char hex');
  }
  if (!isNonNegativeSafeInteger(p.sourceResearchSequence)) throw new Error('POLICY_INVALID: sourceResearchSequence');
  if ((p.sourceResearchSequence as number) >= candidateSeq) {
    throw new Error(`POLICY_INVALID: sourceResearchSequence=${p.sourceResearchSequence} >= publication seq=${candidateSeq}`);
  }
  if (!isNonEmptyTrimmed(p.compilerVersion)) throw new Error('POLICY_INVALID: compilerVersion');

  // Time ordering
  if ((p.compiledAt as number) > (p.effectiveAt as number)) throw new Error('POLICY_INVALID: compiledAt > effectiveAt');
  if ((p.effectiveAt as number) > kernelTimestamp) throw new Error('POLICY_INVALID: effectiveAt > kernelTimestamp');
  if ((p.expiresAt as number) <= (p.effectiveAt as number)) throw new Error('POLICY_INVALID: expiresAt <= effectiveAt');

  // degradeUntil
  if (p.degradeUntil !== undefined) {
    if (!isNonNegativeSafeInteger(p.degradeUntil) || (p.degradeUntil as number) < (p.expiresAt as number)) {
      throw new Error('POLICY_INVALID: degradeUntil < expiresAt');
    }
  }

  // Lifetime
  const lifetime = ((p.degradeUntil ?? p.expiresAt) as number) - (p.effectiveAt as number);
  if (lifetime > maxLifetimeMs) {
    throw new Error(`POLICY_INVALID: lifetime ${lifetime}ms > max ${maxLifetimeMs}ms`);
  }

  // Multiplier
  assertFiniteRange(p.maxPositionMultiplier, 'maxPositionMultiplier', 0, 1);

  // Enums
  if (typeof p.directionBias !== 'string' || !DIRECTION_SET.has(p.directionBias)) {
    throw new Error(`POLICY_INVALID: directionBias=${p.directionBias}`);
  }
  if (typeof p.riskLevel !== 'string' || !RISK_LEVEL_SET.has(p.riskLevel)) {
    throw new Error(`POLICY_INVALID: riskLevel=${p.riskLevel}`);
  }

  // allowNewEntries
  if (typeof p.allowNewEntries !== 'boolean') throw new Error('POLICY_INVALID: allowNewEntries');

  // Symbol lists
  assertUniqueSorted(p.allowedSymbols, 'allowedSymbols');
  assertUniqueSorted(p.blockedSymbols, 'blockedSymbols');
  assertNoIntersection(p.allowedSymbols as string[], p.blockedSymbols as string[], 'allowedSymbols', 'blockedSymbols');

  // Strategy lists
  assertUniqueSorted(p.allowedStrategyIds, 'allowedStrategyIds');
  assertUniqueSorted(p.blockedStrategyIds, 'blockedStrategyIds');
  assertNoIntersection(p.allowedStrategyIds as string[], p.blockedStrategyIds as string[], 'allowedStrategyIds', 'blockedStrategyIds');

  // reasonCodes
  assertUniqueSorted(p.reasonCodes, 'reasonCodes');

  // Symbol rules — mandatory plain object
  if (p.symbolRules === undefined || p.symbolRules === null) {
    throw new Error('POLICY_INVALID: symbolRules missing');
  }
  if (typeof p.symbolRules !== 'object' || Array.isArray(p.symbolRules)) {
    throw new Error('POLICY_INVALID: symbolRules is not a plain object');
  }
  const proto = Object.getPrototypeOf(p.symbolRules);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error('POLICY_INVALID: symbolRules is not a plain object');
  }
    const rules = p.symbolRules as Record<string, unknown>;
    const ruleKeys = Object.keys(rules);
    for (const sym of ruleKeys) {
      if (!isNonEmptyTrimmed(sym)) throw new Error('POLICY_INVALID: symbolRules key empty');
      const rule = rules[sym];
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`POLICY_INVALID: symbolRules.${sym} missing`);

      const r = rule as Record<string, unknown>;
      // Strict schema: reject unknown fields in SymbolPolicyRule
      for (const rk of Object.keys(r)) {
        if (!SYMBOL_RULE_KEYS.has(rk)) throw new Error(`POLICY_INVALID: symbolRules.${sym}.unknown field "${rk}"`);
      }
      // Require every mandatory key in SymbolPolicyRule
      for (const key of SYMBOL_RULE_KEYS) {
        if (!(key in r)) throw new Error(`POLICY_INVALID: symbolRules.${sym}.missing required field "${key}"`);
      }

      if (typeof r.allowNewEntries !== 'boolean') throw new Error(`POLICY_INVALID: symbolRules.${sym}.allowNewEntries`);
      assertFiniteRange(r.maxPositionMultiplier, `symbolRules.${sym}.maxPositionMultiplier`, 0, 1);
      if (typeof r.directionBias !== 'string' || !DIRECTION_SET.has(r.directionBias)) {
        throw new Error(`POLICY_INVALID: symbolRules.${sym}.directionBias`);
      }
      if (typeof r.riskLevel !== 'string' || !RISK_LEVEL_SET.has(r.riskLevel)) {
        throw new Error(`POLICY_INVALID: symbolRules.${sym}.riskLevel`);
      }
      assertUniqueSorted(r.allowedStrategyIds, `symbolRules.${sym}.allowedStrategyIds`);
      assertUniqueSorted(r.blockedStrategyIds, `symbolRules.${sym}.blockedStrategyIds`);
      assertNoIntersection(r.allowedStrategyIds as string[], r.blockedStrategyIds as string[],
        `symbolRules.${sym}.allowedStrategyIds`, `symbolRules.${sym}.blockedStrategyIds`);
      assertUniqueSorted(r.reasonCodes, `symbolRules.${sym}.reasonCodes`);
    }

  // JSON safety (allow shared non-cyclic references)
  try { JSON.stringify(policy); } catch { throw new Error('POLICY_INVALID: not JSON-safe'); }
  assertJsonSafe(policy, 'policy', new WeakSet());
}
