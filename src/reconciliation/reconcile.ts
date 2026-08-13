// Phase 5B: reconcile() — deterministic, pure comparison core.
//
// Recovered Kernel facts + read-only broker/execution truth → reconciliation
// report. This function is the SECOND boundary and is PURE:
//   - no network / LLM / web calls
//   - no order submission, cancellation, retries, or fills
//   - no state mutation
//   - no Date.now() / Math.random() (time & source are explicit inputs)
//
// Identical (local, external) inputs MUST produce an identical report, and
// issue ordering MUST be stable. Any unresolved mismatch ⇒
// reconciliationVerified = false. No mismatch may silently become MATCH.

import { createHash } from 'node:crypto';
import type {
  ExecutionTruthSnapshot,
  ExternalFill,
  ExternalOrder,
  LocalOrder,
  LocalReconciliationSnapshot,
  ReconciliationIssue,
  ReconciliationReport,
  ReconciliationOutcome,
  IssueOutcome,
} from './reconciliation-types';
import { OUTCOME_PRIORITY } from './reconciliation-types';

// ─── Deterministic serialization (for evidence digests + equality) ──────────

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).sort().join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ─── Issue sink ─────────────────────────────────────────────────────────────

interface IssueSink {
  push(issue: ReconciliationIssue): void;
}

// ─── Keyed indexing with fail-closed conflict detection ─────────────────────
// A keyed fact index must NOT use input ordering as authority. Exact duplicates
// may canonical-dedupe; the same identity with conflicting values is
// UNTRUSTED_STATE, never last-write-wins.

interface IndexResult<T> {
  map: Map<string, T>;
  conflictKey: string | null;
}

function indexKeyed<T>(items: readonly T[], keyOf: (item: T) => string): IndexResult<T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) {
      map.set(key, item);
    } else if (stableStringify(map.get(key)) !== stableStringify(item)) {
      return { map, conflictKey: key };
    }
    // exact duplicate → canonical dedupe
  }
  return { map, conflictKey: null };
}

function positionKey(exchange: string, symbol: string): string {
  return `${exchange}\u0000${symbol}`;
}

// ─── Order / fill matching ──────────────────────────────────────────────────

/**
 * Reconcile each local order against external order/fill truth.
 * A correlated orderId is NOT sufficient for agreement: attribution
 * (exchange/symbol/side) and lifecycle compatibility are also enforced.
 */
function reconcileOrders(
  localOrders: readonly LocalOrder[],
  externalOrders: ReadonlyMap<string, ExternalOrder>,
  externalFills: ReadonlyMap<string, readonly ExternalFill[]>,
  sink: IssueSink,
): void {
  for (const lo of localOrders) {
    const extOrder = externalOrders.get(lo.orderId);
    const extFills = externalFills.get(lo.orderId) ?? [];

    // P0-2 attribution: a correlated orderId must agree on exchange/symbol/side.
    if (extOrder && (extOrder.exchange !== lo.exchange || extOrder.symbol !== lo.symbol || extOrder.side !== lo.side)) {
      sink.push({
        outcome: 'UNKNOWN_ORDER',
        reason: `order ${lo.orderId} attribution mismatch: local (${lo.exchange},${lo.symbol},${lo.side}) vs external (${extOrder.exchange},${extOrder.symbol},${extOrder.side})`,
        exchange: lo.exchange,
        symbol: lo.symbol,
        orderId: lo.orderId,
      });
      continue;
    }

    // Contradictory external facts: order reports NOT filled but a fill exists.
    if (extOrder !== undefined && extOrder.status !== 'FILLED' && extFills.length > 0) {
      sink.push({
        outcome: 'UNTRUSTED_STATE',
        reason: `external order ${lo.orderId} reports ${extOrder.status} but a fill record exists (contradictory external truth)`,
        exchange: lo.exchange,
        symbol: lo.symbol,
        orderId: lo.orderId,
      });
      continue;
    }

    const extFilled = (extOrder !== undefined && extOrder.status === 'FILLED') || extFills.length > 0;

    if (lo.status === 'FILLED') {
      // Local recorded a fill. It must be confirmed by an external fill with the
      // SAME fillId AND matching attribution (exchange/symbol/side). A matching
      // fillId/orderId with wrong exchange/symbol/side is NOT confirmation.
      const confirmed = extFills.some((f) =>
        f.fillId === lo.fillId && f.exchange === lo.exchange && f.symbol === lo.symbol && f.side === lo.side
      );
      if (!confirmed) {
        sink.push({
          outcome: 'UNKNOWN_ORDER',
          reason: `local order FILLED with fillId=${lo.fillId ?? '(none)'} is not confirmed by an attribution-matching external fill`,
          exchange: lo.exchange,
          symbol: lo.symbol,
          orderId: lo.orderId,
          fillId: lo.fillId,
        });
      }
      continue;
    }

    // External says filled; local has not recorded the fill → MISSING_FILL.
    if (extFilled) {
      sink.push({
        outcome: 'MISSING_FILL',
        reason: `external truth reports order ${lo.orderId} filled but local fill is absent (local status=${lo.status})`,
        exchange: lo.exchange,
        symbol: lo.symbol,
        orderId: lo.orderId,
      });
      continue;
    }

    // Not filled on either side. Lifecycle compatibility for non-filled states.
    if (lo.status === 'REJECTED') {
      // Local rejected (dead, no fill). External must not still hold it open.
      if (extOrder !== undefined && extOrder.status === 'OPEN') {
        sink.push({
          outcome: 'UNKNOWN_ORDER',
          reason: `local order ${lo.orderId} REJECTED but external reports OPEN`,
          exchange: lo.exchange,
          symbol: lo.symbol,
          orderId: lo.orderId,
        });
      }
      // CANCELLED / NOT_FOUND / absent → consistent (no fill on both sides).
      continue;
    }

    if (lo.status === 'CREATED') {
      // Local only created, never submitted. External must not hold it open or
      // report it cancelled — either way the local order never reached the broker.
      if (extOrder !== undefined && extOrder.status === 'OPEN') {
        sink.push({
          outcome: 'UNKNOWN_ORDER',
          reason: `local order ${lo.orderId} CREATED (never submitted) but external reports OPEN`,
          exchange: lo.exchange,
          symbol: lo.symbol,
          orderId: lo.orderId,
        });
      } else if (extOrder !== undefined && extOrder.status === 'CANCELLED') {
        sink.push({
          outcome: 'UNKNOWN_ORDER',
          reason: `local order ${lo.orderId} CREATED (never submitted) but external reports CANCELLED`,
          exchange: lo.exchange,
          symbol: lo.symbol,
          orderId: lo.orderId,
        });
      }
      continue;
    }

    // SUBMITTED / SUBMISSION_UNKNOWN.
    if (extOrder === undefined || extOrder.status === 'NOT_FOUND') {
      sink.push({
        outcome: 'UNKNOWN_ORDER',
        reason: `local order ${lo.orderId} (status=${lo.status}) cannot be conclusively established from external truth`,
        exchange: lo.exchange,
        symbol: lo.symbol,
        orderId: lo.orderId,
      });
      continue;
    }
    if (extOrder.status === 'CANCELLED') {
      sink.push({
        outcome: 'UNKNOWN_ORDER',
        reason: `local order ${lo.orderId} (status=${lo.status}) but external reports CANCELLED`,
        exchange: lo.exchange,
        symbol: lo.symbol,
        orderId: lo.orderId,
      });
      continue;
    }
    // extOrder OPEN → consistent (both in-flight, not filled).
  }
}

/**
 * Reconcile external orders/fills that have no corresponding local order.
 * Emits ORPHAN_ORDER.
 */
function reconcileOrphans(
  externalOrders: ReadonlyMap<string, ExternalOrder>,
  externalFills: ReadonlyMap<string, readonly ExternalFill[]>,
  localOrderIds: ReadonlySet<string>,
  sink: IssueSink,
): void {
  for (const [, eo] of externalOrders) {
    if (!localOrderIds.has(eo.orderId)) {
      sink.push({
        outcome: 'ORPHAN_ORDER',
        reason: `external order ${eo.orderId} has no corresponding local OMS order`,
        exchange: eo.exchange,
        symbol: eo.symbol,
        orderId: eo.orderId,
      });
    }
  }
  for (const [orderId, fs] of externalFills) {
    if (!localOrderIds.has(orderId)) {
      for (const f of fs) {
        sink.push({
          outcome: 'ORPHAN_ORDER',
          reason: `external fill ${f.fillId} references order ${orderId} with no local OMS order`,
          exchange: f.exchange,
          symbol: f.symbol,
          orderId,
          fillId: f.fillId,
        });
      }
    }
  }
}

// ─── Position reconciliation ────────────────────────────────────────────────

/**
 * Compare positions preserving the factual semantics missing != flat != open.
 * - A local `missing` position has no factual record; it must NEVER reconcile
 *   to MATCH (fail-closed) — it is POSITION_MISMATCH.
 * - A local `flat` position with no external open position MAY MATCH.
 * - Agreed open positions must also match averageEntryPrice.
 */
function reconcilePositions(
  localPositions: LocalReconciliationSnapshot['positions'],
  externalPositions: ExecutionTruthSnapshot['positions'],
  sink: IssueSink,
): void {
  const localByKey = new Map<string, LocalReconciliationSnapshot['positions'][number]>();
  for (const lp of localPositions) localByKey.set(positionKey(lp.exchange, lp.symbol), lp);

  const externalOpenByKey = new Map<string, ExecutionTruthSnapshot['positions'][number]>();
  for (const ep of externalPositions) {
    if (ep.signedQuantity !== 0) externalOpenByKey.set(positionKey(ep.exchange, ep.symbol), ep);
  }

  const keys = new Set<string>([...localByKey.keys(), ...externalOpenByKey.keys()]);
  const sortedKeys = [...keys].sort();

  for (const key of sortedKeys) {
    const lp = localByKey.get(key);
    const ep = externalOpenByKey.get(key);

    // P0-1: missing is a factual gap, never silently MATCH.
    if (lp && lp.status === 'missing') {
      sink.push({
        outcome: 'POSITION_MISMATCH',
        reason: `local position ${key} has no factual record (missing); cannot reconcile to MATCH`,
        exchange: lp.exchange,
        symbol: lp.symbol,
      });
      continue;
    }

    const localOpen = !!lp && lp.status === 'open' && lp.signedQuantity !== 0;

    if (localOpen && !ep) {
      sink.push({
        outcome: 'POSITION_MISMATCH',
        reason: `local records open position ${key} that external truth does not confirm`,
        exchange: lp!.exchange,
        symbol: lp!.symbol,
      });
      continue;
    }
    if (!localOpen && ep) {
      sink.push({
        outcome: 'POSITION_MISMATCH',
        reason: `external truth reports open position ${key} absent from local state`,
        exchange: ep.exchange,
        symbol: ep.symbol,
      });
      continue;
    }
    if (localOpen && ep) {
      if (lp!.side !== ep.side || lp!.signedQuantity !== ep.signedQuantity) {
        sink.push({
          outcome: 'POSITION_MISMATCH',
          reason: `position ${key} differs: local ${lp!.side} ${lp!.signedQuantity} vs external ${ep.side} ${ep.signedQuantity}`,
          exchange: lp!.exchange,
          symbol: lp!.symbol,
        });
      } else if (lp!.averageEntryPrice !== ep.averageEntryPrice) {
        sink.push({
          outcome: 'POSITION_MISMATCH',
          reason: `position ${key} average entry differs: local ${lp!.averageEntryPrice} vs external ${ep.averageEntryPrice}`,
          exchange: lp!.exchange,
          symbol: lp!.symbol,
        });
      }
    }
    // else: no open on either side (local flat/absent + external absent) → agree.
  }
}

// ─── Protection reconciliation ──────────────────────────────────────────────

/**
 * Every factually open position (per external truth) must have an active local
 * protection plan matching the position side. The active-plan index is built
 * with fail-closed conflict detection (no array-order authority).
 */
function reconcileProtection(
  activePlans: ReadonlyMap<string, LocalReconciliationSnapshot['plans'][number]>,
  externalPositions: ExecutionTruthSnapshot['positions'],
  sink: IssueSink,
): void {
  const open = externalPositions.filter((ep) => ep.signedQuantity !== 0);
  const sorted = [...open].sort((a, b) => positionKey(a.exchange, a.symbol).localeCompare(positionKey(b.exchange, b.symbol)));

  for (const ep of sorted) {
    const plan = activePlans.get(positionKey(ep.exchange, ep.symbol));
    if (!plan || plan.positionSide !== ep.side) {
      sink.push({
        outcome: 'MISSING_PROTECTION',
        reason: `factual open position ${positionKey(ep.exchange, ep.symbol)} (${ep.side}) has no active local protection plan`,
        exchange: ep.exchange,
        symbol: ep.symbol,
        planId: plan?.planId,
      });
    }
  }
}

// ─── Identity / untrusted preconditions ─────────────────────────────────────

function identityEqual(
  a: LocalReconciliationSnapshot['identity'],
  b: ExecutionTruthSnapshot['identity'],
): boolean {
  return a.accountId === b.accountId && a.exchange === b.exchange;
}

// ─── Issue ordering ─────────────────────────────────────────────────────────

function sortIssues(issues: ReconciliationIssue[]): ReconciliationIssue[] {
  return issues.sort((a, b) => {
    const pa = OUTCOME_PRIORITY[a.outcome];
    const pb = OUTCOME_PRIORITY[b.outcome];
    if (pa !== pb) return pa - pb;
    const ka = [a.exchange ?? '', a.symbol ?? '', a.orderId ?? '', a.fillId ?? '', a.planId ?? '', a.reason].join('\u0000');
    const kb = [b.exchange ?? '', b.symbol ?? '', b.orderId ?? '', b.fillId ?? '', b.planId ?? '', b.reason].join('\u0000');
    return ka.localeCompare(kb);
  });
}

// ─── Core ───────────────────────────────────────────────────────────────────

export function reconcile(
  local: LocalReconciliationSnapshot,
  external: ExecutionTruthSnapshot,
): ReconciliationReport {
  // 1. Untrusted preconditions (short-circuit — no comparison is meaningful).
  if (!external.complete) {
    return buildReport(local, external, [{ outcome: 'UNTRUSTED_STATE', reason: external.incompleteReason ?? 'external truth is incomplete' }]);
  }
  if (!identityEqual(local.identity, external.identity)) {
    return buildReport(local, external, [{
      outcome: 'UNTRUSTED_STATE',
      reason: `identity mismatch: local=${local.identity.accountId}@${local.identity.exchange} vs external=${external.identity.accountId}@${external.identity.exchange}`,
    }]);
  }

  // 2. Fail-closed conflict detection on keyed facts (never order-dependent).
  const localOrdersIdx = indexKeyed(local.orders, (o) => o.orderId);
  if (localOrdersIdx.conflictKey !== null) return untrusted(local, external, `conflicting local order facts for orderId ${localOrdersIdx.conflictKey}`);
  const localPositionsIdx = indexKeyed(local.positions, (p) => positionKey(p.exchange, p.symbol));
  if (localPositionsIdx.conflictKey !== null) return untrusted(local, external, `conflicting local position facts for ${localPositionsIdx.conflictKey}`);
  const localPlansIdx = indexKeyed(local.plans, (p) => p.planId);
  if (localPlansIdx.conflictKey !== null) return untrusted(local, external, `conflicting local plan facts for planId ${localPlansIdx.conflictKey}`);

  // P0-3: active protection plans must not use array order as authority.
  // Conflicting active plans for the same position key fail closed.
  const activePlansIdx = indexKeyed(
    local.plans.filter((p) => p.status === 'active'),
    (p) => positionKey(p.exchange, p.symbol),
  );
  if (activePlansIdx.conflictKey !== null) return untrusted(local, external, `conflicting active protection plans for ${activePlansIdx.conflictKey}`);

  const externalOrdersIdx = indexKeyed(external.orders, (o) => o.orderId);
  if (externalOrdersIdx.conflictKey !== null) return untrusted(local, external, `conflicting external order facts for orderId ${externalOrdersIdx.conflictKey}`);
  const externalFillsIdx = indexKeyed(external.fills, (f) => f.fillId);
  if (externalFillsIdx.conflictKey !== null) return untrusted(local, external, `conflicting external fill facts for fillId ${externalFillsIdx.conflictKey}`);
  const externalPositionsIdx = indexKeyed(external.positions, (p) => positionKey(p.exchange, p.symbol));
  if (externalPositionsIdx.conflictKey !== null) return untrusted(local, external, `conflicting external position facts for ${externalPositionsIdx.conflictKey}`);

  // 3. Derived indexes.
  const externalFills = new Map<string, ExternalFill[]>();
  for (const f of externalFillsIdx.map.values()) {
    const list = externalFills.get(f.orderId) ?? [];
    list.push(f);
    externalFills.set(f.orderId, list);
  }
  const localOrderIds = new Set<string>(localOrdersIdx.map.keys());

  // 4. Reconcile.
  const issues: ReconciliationIssue[] = [];
  const sink: IssueSink = { push: (i) => issues.push(i) };

  const sortedLocalOrders = [...localOrdersIdx.map.values()].sort((a, b) => a.orderId.localeCompare(b.orderId));
  reconcileOrders(sortedLocalOrders, externalOrdersIdx.map, externalFills, sink);
  reconcileOrphans(externalOrdersIdx.map, externalFills, localOrderIds, sink);
  reconcilePositions(local.positions, external.positions, sink);
  reconcileProtection(activePlansIdx.map, external.positions, sink);

  return buildReport(local, external, sortIssues(issues));
}

function untrusted(
  local: LocalReconciliationSnapshot,
  external: ExecutionTruthSnapshot,
  reason: string,
): ReconciliationReport {
  return buildReport(local, external, [{ outcome: 'UNTRUSTED_STATE', reason }]);
}

function buildReport(
  local: LocalReconciliationSnapshot,
  external: ExecutionTruthSnapshot,
  issues: ReconciliationIssue[],
): ReconciliationReport {
  const sorted = sortIssues([...issues]);
  const primary: ReconciliationOutcome = sorted.length === 0 ? 'MATCH' : (sorted[0].outcome as ReconciliationOutcome);
  const frozenIssues = sorted.map((i) => Object.freeze({ ...i }));
  return Object.freeze({
    outcome: primary,
    reconciliationVerified: frozenIssues.length === 0,
    issues: Object.freeze(frozenIssues),
    identity: Object.freeze({ ...external.identity }),
    source: external.source,
    capturedAt: external.capturedAt,
    localDigest: sha256(stableStringify(local)),
    externalDigest: sha256(stableStringify(external)),
  } satisfies ReconciliationReport);
}
