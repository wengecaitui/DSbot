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

// ─── Deterministic serialization (for evidence digests) ─────────────────────

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

// ─── Order / fill matching ──────────────────────────────────────────────────

interface IssueSink {
  push(issue: ReconciliationIssue): void;
}

function externalFilledForOrder(orderId: string, orders: ReadonlyMap<string, ExternalOrder>, fills: ReadonlyMap<string, readonly ExternalFill[]>): boolean {
  const order = orders.get(orderId);
  if (order && order.status === 'FILLED') return true;
  const fs = fills.get(orderId);
  return !!fs && fs.length > 0;
}

/**
 * Reconcile each local order against external order/fill truth.
 * Emits UNKNOWN_ORDER / MISSING_FILL for the frozen taxonomy.
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

    // Does external truth say this order filled (by status or by a fill record)?
    const extFilled = externalFilledForOrder(lo.orderId, externalOrders, externalFills);

    if (lo.status === 'FILLED') {
      // Local recorded a fill. It must be confirmed by an external fill with
      // the SAME fillId. A local fill the broker cannot confirm is unresolved.
      const confirmed = extFills.some((f) => f.fillId === lo.fillId);
      if (!confirmed) {
        sink.push({
          outcome: 'UNKNOWN_ORDER',
          reason: `local order FILLED with fillId=${lo.fillId ?? '(none)'} is not confirmed by external truth`,
          exchange: lo.exchange,
          symbol: lo.symbol,
          orderId: lo.orderId,
          fillId: lo.fillId,
        });
      }
      continue;
    }

    if (lo.status === 'REJECTED') {
      // Local says rejected. External must NOT report a fill for this order.
      if (extFilled) {
        sink.push({
          outcome: 'MISSING_FILL',
          reason: `external truth reports a fill for local order ${lo.orderId} recorded as REJECTED`,
          exchange: lo.exchange,
          symbol: lo.symbol,
          orderId: lo.orderId,
        });
      }
      continue;
    }

    // CREATED / SUBMITTED / SUBMISSION_UNKNOWN — non-terminal local states.
    if (extFilled) {
      // External says filled; local has not recorded the fill.
      sink.push({
        outcome: 'MISSING_FILL',
        reason: `external truth reports order ${lo.orderId} filled but local fill is absent (local status=${lo.status})`,
        exchange: lo.exchange,
        symbol: lo.symbol,
        orderId: lo.orderId,
      });
      continue;
    }

    // Not filled on either side. Only SUBMITTED / SUBMISSION_UNKNOWN can be
    // UNKNOWN_ORDER when the broker has no conclusive record of the order.
    if (lo.status === 'SUBMITTED' || lo.status === 'SUBMISSION_UNKNOWN') {
      if (!extOrder || extOrder.status === 'NOT_FOUND') {
        sink.push({
          outcome: 'UNKNOWN_ORDER',
          reason: `local order ${lo.orderId} (status=${lo.status}) cannot be conclusively established from external truth`,
          exchange: lo.exchange,
          symbol: lo.symbol,
          orderId: lo.orderId,
        });
      }
      // extOrder OPEN / CANCELLED → broker knows it and has not filled it:
      // consistent with a local non-filled state (no fill discrepancy).
    }
    // CREATED with no external fill/record → never reached the broker; consistent.
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
  // External orders unknown locally.
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
  // External fills whose order is unknown locally imply an orphan order.
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

function positionKey(exchange: string, symbol: string): string {
  return `${exchange}\u0000${symbol}`;
}

/**
 * Compare open positions. "Open" means signedQuantity !== 0.
 * Local missing/flat are NOT collapsed into each other in the report — the
 * local snapshot carries the exact status. Reconciliation only asserts that the
 * set of OPEN positions (side + signedQuantity) is identical on both sides.
 */
function reconcilePositions(
  localPositions: LocalReconciliationSnapshot['positions'],
  externalPositions: ExecutionTruthSnapshot['positions'],
  sink: IssueSink,
): void {
  const localOpen = new Map<string, LocalReconciliationSnapshot['positions'][number]>();
  for (const lp of localPositions) {
    if (lp.status === 'open' && lp.signedQuantity !== 0) localOpen.set(positionKey(lp.exchange, lp.symbol), lp);
  }
  const externalOpen = new Map<string, ExecutionTruthSnapshot['positions'][number]>();
  for (const ep of externalPositions) {
    if (ep.signedQuantity !== 0) externalOpen.set(positionKey(ep.exchange, ep.symbol), ep);
  }

  const keys = new Set<string>([...localOpen.keys(), ...externalOpen.keys()]);
  const sortedKeys = [...keys].sort();

  for (const key of sortedKeys) {
    const lp = localOpen.get(key);
    const ep = externalOpen.get(key);

    if (lp && !ep) {
      sink.push({
        outcome: 'POSITION_MISMATCH',
        reason: `local records open position ${key} that external truth does not confirm`,
        exchange: lp.exchange,
        symbol: lp.symbol,
      });
      continue;
    }
    if (!lp && ep) {
      sink.push({
        outcome: 'POSITION_MISMATCH',
        reason: `external truth reports open position ${key} absent from local state`,
        exchange: ep.exchange,
        symbol: ep.symbol,
      });
      continue;
    }
    if (lp && ep) {
      if (lp.side !== ep.side || lp.signedQuantity !== ep.signedQuantity) {
        sink.push({
          outcome: 'POSITION_MISMATCH',
          reason: `position ${key} differs: local ${lp.side} ${lp.signedQuantity} vs external ${ep.side} ${ep.signedQuantity}`,
          exchange: lp.exchange,
          symbol: lp.symbol,
        });
      }
    }
  }
}

// ─── Protection reconciliation ──────────────────────────────────────────────

/**
 * Every factually open position (per external truth) must have an active local
 * protection plan matching the position side.
 */
function reconcileProtection(
  localPlans: LocalReconciliationSnapshot['plans'],
  externalPositions: ExecutionTruthSnapshot['positions'],
  sink: IssueSink,
): void {
  const activePlanByKey = new Map<string, LocalReconciliationSnapshot['plans'][number]>();
  for (const plan of localPlans) {
    if (plan.status === 'active') activePlanByKey.set(positionKey(plan.exchange, plan.symbol), plan);
  }

  const open = externalPositions.filter((ep) => ep.signedQuantity !== 0);
  const sorted = [...open].sort((a, b) => positionKey(a.exchange, a.symbol).localeCompare(positionKey(b.exchange, b.symbol)));

  for (const ep of sorted) {
    const plan = activePlanByKey.get(positionKey(ep.exchange, ep.symbol));
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
  const issues: ReconciliationIssue[] = [];
  const sink: IssueSink = { push: (i) => issues.push(i) };

  // 1. Untrusted preconditions (short-circuit — no comparison is meaningful).
  if (!external.complete) {
    return buildReport(local, external, [{
      outcome: 'UNTRUSTED_STATE',
      reason: external.incompleteReason ?? 'external truth is incomplete',
    }]);
  }
  if (!identityEqual(local.identity, external.identity)) {
    return buildReport(local, external, [{
      outcome: 'UNTRUSTED_STATE',
      reason: `identity mismatch: local=${local.identity.accountId}@${local.identity.exchange} vs external=${external.identity.accountId}@${external.identity.exchange}`,
    }]);
  }

  // Index external truth (deterministic: input is treated as an unordered set).
  const externalOrders = new Map<string, ExternalOrder>();
  for (const eo of external.orders) externalOrders.set(eo.orderId, eo);
  const externalFills = new Map<string, ExternalFill[]>();
  for (const f of external.fills) {
    const list = externalFills.get(f.orderId) ?? [];
    list.push(f);
    externalFills.set(f.orderId, list);
  }

  const localOrderIds = new Set<string>(local.orders.map((o) => o.orderId));

  // 2. Order / fill reconciliation.
  const sortedLocalOrders = [...local.orders].sort((a, b) => a.orderId.localeCompare(b.orderId));
  reconcileOrders(sortedLocalOrders, externalOrders, externalFills, sink);

  // 3. Orphan orders (external without local).
  reconcileOrphans(externalOrders, externalFills, localOrderIds, sink);

  // 4. Position reconciliation.
  reconcilePositions(local.positions, external.positions, sink);

  // 5. Protection reconciliation.
  reconcileProtection(local.plans, external.positions, sink);

  return buildReport(local, external, sortIssues(issues));
}

function buildReport(
  local: LocalReconciliationSnapshot,
  external: ExecutionTruthSnapshot,
  issues: ReconciliationIssue[],
): ReconciliationReport {
  const sorted = sortIssues([...issues]);
  const primary: ReconciliationOutcome = sorted.length === 0 ? 'MATCH' : (sorted[0].outcome as ReconciliationOutcome);
  return Object.freeze({
    outcome: primary,
    reconciliationVerified: sorted.length === 0,
    issues: Object.freeze(sorted),
    identity: Object.freeze({ ...external.identity }),
    source: external.source,
    capturedAt: external.capturedAt,
    localDigest: sha256(stableStringify(local)),
    externalDigest: sha256(stableStringify(external)),
  } satisfies ReconciliationReport);
}
