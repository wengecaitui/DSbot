// Phase 5B: PaperExecutionTruthPort — the ExecutionTruthPort over the real
// PaperExecutionService / PaperBroker truth.
//
// Uses ONLY factual Paper service state: getIdentity(), snapshot(), entries().
// Never consults local OMS / position / plan / journal state to manufacture
// broker facts. An uncorrelated persisted fill (no sourceOrderId) fails closed
// with complete=false → reconcile() returns UNTRUSTED_STATE.

import type { PaperExecutionService } from '../paper/PaperExecutionService';
import type { PaperPosition } from '../types/paper-account';
import type {
  ExecutionTruthPort,
  ExecutionTruthSnapshot,
  ExternalFill,
  ExternalOrder,
  ExternalPosition,
} from './reconciliation-types';

export interface PaperExecutionTruthPortOptions {
  service: PaperExecutionService;
  /** Acquisition timestamp source (nondeterministic boundary). Defaults to Date.now. */
  now?: () => number;
  /** Provenance label. */
  source?: string;
}

function mapPosition(p: PaperPosition): ExternalPosition {
  return {
    exchange: p.exchange,
    symbol: p.symbol,
    side: p.direction,
    signedQuantity: p.signedQuantity,
    averageEntryPrice: p.averageEntryPriceUsd,
    updatedAt: p.updatedAt,
  };
}

export function createPaperExecutionTruthPort(options: PaperExecutionTruthPortOptions): ExecutionTruthPort {
  const service = options.service;
  const now = options.now ?? (() => Date.now());
  const source = options.source ?? 'paper-broker';

  return {
    async acquireTruth(): Promise<ExecutionTruthSnapshot> {
      const capturedAt = now();
      const identity = service.getIdentity();

      // Identity must be established — otherwise the snapshot is not trustworthy.
      if (!identity || !identity.accountId || !identity.exchange) {
        return {
          identity: identity as ExecutionTruthSnapshot['identity'],
          orders: [], fills: [], positions: [],
          capturedAt, source,
          complete: false,
          incompleteReason: 'account identity cannot be established',
        };
      }

      const snapshot = service.snapshot();
      const entries = service.entries();

      const positions: ExternalPosition[] = snapshot.positions.map(mapPosition);

      // Map fills; require conclusive OMS correlation on every persisted fill.
      const fills: ExternalFill[] = [];
      let uncorrelated = false;
      let malformed = false;
      for (const entry of entries) {
        if (entry.type !== 'fill') continue;
        const f = entry.fill;
        const hasOrder = f.sourceOrderId !== undefined && f.sourceOrderId !== '';
        const hasIntent = f.sourceIntentId !== undefined && f.sourceIntentId !== '';
        if (hasOrder !== hasIntent) {
          // Partial correlation pair is malformed — never complete=true.
          malformed = true;
          continue;
        }
        if (!hasOrder) {
          // Generic/non-OMS fill — never fabricate an orderId; fail closed.
          uncorrelated = true;
          continue;
        }
        fills.push({
          fillId: f.fillId,
          orderId: f.sourceOrderId,
          exchange: f.exchange,
          symbol: f.symbol,
          side: f.side,
          quantity: f.quantity,
          price: f.priceUsd,
          executedAt: f.executedAt,
        });
      }

      if (malformed) {
        return {
          identity: identity as ExecutionTruthSnapshot['identity'],
          orders: [], fills, positions,
          capturedAt, source,
          complete: false,
          incompleteReason: 'persisted Paper fill has a partial OMS correlation pair (sourceOrderId/sourceIntentId)',
        };
      }

      if (uncorrelated) {
        return {
          identity: identity as ExecutionTruthSnapshot['identity'],
          orders: [], fills, positions,
          capturedAt, source,
          complete: false,
          incompleteReason: 'persisted Paper fill lacks required OMS correlation (sourceOrderId)',
        };
      }

      // Orders: Paper execution is immediate-fill — a conclusively correlated
      // persisted fill exposes the corresponding external order as FILLED. No
      // OPEN/CANCELLED/NOT_FOUND paper orders are invented.
      const orders: ExternalOrder[] = fills.map((f) => ({
        orderId: f.orderId,
        exchange: f.exchange,
        symbol: f.symbol,
        side: f.side,
        quantity: f.quantity,
        status: 'FILLED',
        filledQuantity: f.quantity,
        averageFillPrice: f.price,
        updatedAt: f.executedAt,
      }));

      return {
        identity: identity as ExecutionTruthSnapshot['identity'],
        orders, fills, positions,
        capturedAt, source,
        complete: true,
      };
    },
  };
}
