/** Gate factual reads projected into the existing, fail-closed reconciliation schema. */
import { gateIoEthContractSizeValid, gateIoExecutionSecondsToMilliseconds, toGateIoClientText } from '../exchanges/gateio-futures/GateIoFuturesExecutionAdapter';
import type { OmsOrderSnapshot } from '../oms/oms-types';
import type { OrderExecutionObservation } from '../oms/oms-types';
import { gateIoOrderExecutionObservation } from '../exchanges/gateio-futures/GateIoFuturesExecutionAdapter';
import { planExecutionObservation, quantityEqual } from '../oms/execution-observation';
import { multiplyQuantity, subtractQuantity } from '../types/decimal-quantity';
import type { GateIoAuthenticatedReadFoundation, GateIoCanonicalAccountTruth, GateIoCanonicalInstrumentFacts, GateIoCanonicalTrade, GateIoCanonicalOpenOrder } from '../runtime/gateio/GateIoAuthenticatedReadFoundation';
import type { GateIoReadTransport } from '../runtime/gateio/GateIoReadContracts';
import { gateIoReadTransportBudget, gateIoReadTransportEnvironment } from '../runtime/gateio/GateIoReadTransport';
import { GateIoG3RunBudget } from '../runtime/gateio/GateIoG3RunBudget';
import type { GateIoCurrentRunOrderAttestation } from '../runtime/gateio/GateIoFuturesExecutionClient';
import type { ExecutionTruthPort, ExecutionTruthSnapshot, ExternalFill, ExternalOrder, ExternalPosition } from './reconciliation-types';

export interface GateIoExecutionTruthPortOptions {
  readonly environment: 'testnet' | 'live';
  readonly transport: GateIoReadTransport;
  readonly runBudget: GateIoG3RunBudget;
  readonly foundation: Pick<GateIoAuthenticatedReadFoundation, 'accountTruth' | 'instrumentFacts'>;
  readonly accountId: string;
  readonly now: () => number;
  /** Correlation candidates only; broker facts come exclusively from Gate reads. */
  readonly listOmsOrders: () => readonly OmsOrderSnapshot[];
  /** Existing G2 exact-order GET. Pending cumulative facts refresh only on explicit acquisition;
   * terminal attestations are cached. All calls share the unchanged bounded request budget. */
  readonly attestCurrentRunOrder?: (clientText: string, order?: OmsOrderSnapshot) => Promise<GateIoCurrentRunOrderAttestation | null>;
}

export interface GateIoExecutionTruthPort extends ExecutionTruthPort {
  readonly environment: 'testnet' | 'live';
  captureSequence(): number;
  isLatestTruth(value: ExecutionTruthSnapshot): boolean;
  canonicalForCapture(sequence: number): Readonly<{
    account: GateIoCanonicalAccountTruth;
    instrument: GateIoCanonicalInstrumentFacts;
  }> | null;
  refreshInstrumentFacts(): Promise<GateIoCanonicalInstrumentFacts | null>;
  currentInstrument(): GateIoCanonicalInstrumentFacts | null;
  currentRunTradeHistory(): 'NONE' | 'LAGGING' | 'CONVERGED' | 'UNKNOWN';
  /** Called only by verified bootstrap; fixes a run-scoped historical trade boundary. */
  establishVerifiedTradeBoundary(truth: ExecutionTruthSnapshot): void;
}

function tradeFingerprint(trade: GateIoCanonicalTrade): string {
  return JSON.stringify(trade);
}

/** Compare native contract units BEFORE discarding the earlier open-list projection.
 * Remaining is an unsigned magnitude in the canonical open-order contract. Only a
 * factually newer exact observation may reduce it; equal/unknown time is not progress proof.
 */
function openOrdersAgreeWithAttestation(
  openOrders: readonly GateIoCanonicalOpenOrder[], attested: GateIoCurrentRunOrderAttestation,
): boolean {
  const { request, result } = attested;
  const requested = Math.abs(request.size);
  const filled = Math.abs(result.signedFilledSize);
  if (!Number.isFinite(filled) || filled > requested) return false;
  const remaining = subtractQuantity(requested, filled);
  return openOrders.every(order => {
    if (order.clientText !== request.text && order.orderId !== result.exchangeOrderId) return true;
    if (order.orderId !== result.exchangeOrderId || order.clientText !== request.text
        || order.clientText !== result.clientText || order.contract !== request.contract
        || order.contract !== result.contract || !quantityEqual(order.signedSize, request.size)
        || order.reduceOnly !== request.reduceOnly || order.close
        || order.timeInForce !== request.tif
        || (order.price !== null && order.price !== Number(request.price))
        || !Number.isFinite(order.remainingSize) || order.remainingSize < 0
        || order.remainingSize > requested) return false;
    const listedAt = order.updatedAt === null ? null : gateIoExecutionSecondsToMilliseconds(order.updatedAt);
    const exactAt = gateIoExecutionSecondsToMilliseconds(result.executedAt);
    if (listedAt !== null && exactAt !== null && listedAt > exactAt
        && (result.terminal === true || result.status === 'FINISHED' || result.status === 'REJECTED'))
      return false; // A later open fact cannot silently revive a cached terminal order.
    if (quantityEqual(remaining, order.remainingSize)) {
      return filled === 0 || order.fillPrice === null
        || (result.averagePrice !== null && quantityEqual(order.fillPrice, result.averagePrice));
    }
    return listedAt !== null && exactAt !== null && exactAt > listedAt
      && remaining < order.remainingSize;
  });
}

export function createGateIoExecutionTruthPort(options: GateIoExecutionTruthPortOptions): GateIoExecutionTruthPort {
  if (!options || (options.environment !== 'testnet' && options.environment !== 'live')
      || gateIoReadTransportEnvironment(options.transport) !== options.environment
      || gateIoReadTransportBudget(options.transport) !== options.runBudget
      || !(options.runBudget instanceof GateIoG3RunBudget)
      || typeof options.accountId !== 'string' || options.accountId.length === 0
      || typeof options.now !== 'function' || typeof options.listOmsOrders !== 'function'
      || (options.attestCurrentRunOrder !== undefined
        && typeof options.attestCurrentRunOrder !== 'function')
      || typeof options.foundation?.accountTruth !== 'function'
      || typeof options.foundation.instrumentFacts !== 'function') {
    throw new Error('GATEIO_TRUTH_BINDING_INVALID');
  }
  let sequence = 0;
  let instrument: GateIoCanonicalInstrumentFacts | null = null;
  let latest: Readonly<{ account: GateIoCanonicalAccountTruth; instrument: GateIoCanonicalInstrumentFacts }> | null = null;
  let latestTruth: ExecutionTruthSnapshot | null = null;
  let tradeHistory: ReturnType<GateIoExecutionTruthPort['currentRunTradeHistory']> = 'UNKNOWN';
  const orderAttestations = new Map<string, GateIoCurrentRunOrderAttestation | null>();
  let tradeBoundary: Readonly<{
    serverTimeMs: number;
    observedTradeFingerprints: ReadonlyMap<string, string>;
  }> | null = null;
  const identity = Object.freeze({ exchange: 'gateio' as const, accountId: options.accountId });

  async function refreshInstrumentFacts(): Promise<GateIoCanonicalInstrumentFacts | null> {
    latest = null;
    latestTruth = null;
    instrument = null;
    const read = await options.foundation.instrumentFacts();
    if (read.availability === 'AVAILABLE' && read.value?.freshness === 'FRESH'
        && read.value.contractOpenable && !read.value.inDelisting) instrument = read.value;
    return instrument;
  }

  return Object.freeze({
    environment: options.environment,
    captureSequence: () => sequence,
    isLatestTruth: (value: ExecutionTruthSnapshot) => value === latestTruth,
    canonicalForCapture: (expected: number) => expected === sequence ? latest : null,
    refreshInstrumentFacts,
    currentInstrument: () => instrument !== null && options.now() >= instrument.observedAtMs
      && options.now() - instrument.observedAtMs <= 30_000
      ? instrument : null,
    currentRunTradeHistory: () => tradeHistory,
    establishVerifiedTradeBoundary(truth: ExecutionTruthSnapshot): void {
      const account = latest?.account;
      if (tradeBoundary !== null || sequence !== 1 || truth !== latestTruth
          || !truth.complete || account === undefined || account.accountState !== 'FLAT'
          || account.openOrders.length !== 0 || options.listOmsOrders().length !== 0
          || account.positions.some((leg) => leg.signedSize !== 0 || leg.quoteValue !== 0)
          || !Number.isSafeInteger(account.serverTimeMs) || account.serverTimeMs <= 0) {
        throw new Error('GATEIO_TRADE_BOUNDARY_DENIED');
      }
      tradeBoundary = Object.freeze({
        serverTimeMs: account.serverTimeMs,
        observedTradeFingerprints: new Map(account.recentTrades.map((trade) =>
          [trade.tradeId, tradeFingerprint(trade)])),
      });
    },
    async acquireTruth(): Promise<ExecutionTruthSnapshot> {
      sequence += 1;
      latest = null;
      latestTruth = null;
      tradeHistory = 'UNKNOWN';
      const source = `gateio-${options.environment}-read:capture-${sequence}`;
      const read = await options.foundation.accountTruth(); // always a new factual 5-GET path
      if (instrument === null && read.availability === 'AVAILABLE') await refreshInstrumentFacts();
      const capturedAt = options.now();
      const unavailable = (reason: string): ExecutionTruthSnapshot => {
        latestTruth = Object.freeze({ identity, orders: Object.freeze([]), fills: Object.freeze([]),
          positions: Object.freeze([]), capturedAt, source, complete: false, incompleteReason: reason });
        return latestTruth;
      };
      if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) return unavailable('CAPTURE_TIME_INVALID');
      const account = read.value;
      const facts = instrument;
      if (read.availability !== 'AVAILABLE' || account === null || facts === null
          || account.identity.exchange !== 'gateio' || account.identity.accountId !== options.accountId
          || account.freshness !== 'FRESH' || facts.freshness !== 'FRESH'
          || capturedAt < account.observedAtMs || capturedAt < facts.observedAtMs
          || capturedAt - facts.observedAtMs > 30_000) {
        return unavailable(read.reason ?? 'GATEIO_FACTUAL_TRUTH_UNAVAILABLE');
      }
      latest = Object.freeze({ account, instrument: facts });
      const byText = new Map<string, OmsOrderSnapshot>();
      const localOrders = options.listOmsOrders();
      const bootstrap = tradeBoundary === null && sequence === 1 && localOrders.length === 0
        && account.accountState === 'FLAT' && account.openOrders.length === 0;
      for (const order of localOrders) {
        if (order.exchange !== 'gateio' || order.symbol !== 'ETH/USDT') return unavailable('OMS_IDENTITY_MISMATCH');
        let text: string;
        try { text = toGateIoClientText(order.orderId); }
        catch { return unavailable('OMS_CORRELATION_INVALID'); }
        if (byText.has(text)) return unavailable('OMS_CLIENT_TEXT_COLLISION');
        byText.set(text, order);
      }
      const positions: ExternalPosition[] = [];
      let incomplete: string | null = null;
      for (const leg of account.positions) {
        if (leg.signedSize === 0 && leg.quoteValue === 0) continue;
        const quantity = multiplyQuantity(leg.signedSize, facts.contractMultiplier);
        const updatedAt = gateIoExecutionSecondsToMilliseconds(leg.updatedAt);
        if (!Number.isFinite(quantity) || quantity === 0 || updatedAt === null
            || leg.entryPrice === null || leg.entryPrice <= 0) {
          incomplete = 'GATEIO_POSITION_QUANTITY_UNPROVABLE';
          break;
        }
        positions.push(Object.freeze({ exchange: 'gateio', symbol: 'ETH/USDT',
          side: quantity > 0 ? 'long' : 'short', signedQuantity: quantity,
          averageEntryPrice: leg.entryPrice, updatedAt }));
      }
      if (positions.length > 1) incomplete ??= 'DUAL_LEG_RECONCILIATION_UNSUPPORTED';
      const orders: ExternalOrder[] = [];
      for (const order of account.openOrders) {
        const local = order.clientText === null ? null : byText.get(order.clientText);
        const updatedAt = gateIoExecutionSecondsToMilliseconds(order.updatedAt ?? order.createdAt);
        const quantity = multiplyQuantity(Math.abs(order.signedSize), facts.contractMultiplier);
        if (!local || updatedAt === null || !Number.isFinite(quantity) || quantity <= 0
            || local.side !== (order.signedSize > 0 ? 'buy' : 'sell')) {
          incomplete ??= 'GATEIO_OPEN_ORDER_UNCORRELATED';
          continue;
        }
        orders.push(Object.freeze({ orderId: local.orderId, exchange: 'gateio', symbol: 'ETH/USDT',
          side: local.side, quantity, status: 'OPEN', filledQuantity: 0,
          averageFillPrice: null, updatedAt }));
      }
      // G2's OMS fill identity is Gate's filled IOC order id. Aggregate only factual
      // personal trades for that exact exchange order; never invent a trade-level id.
      const tradeGroups = new Map<string, { local: OmsOrderSnapshot; quantity: number;
        notional: number; executedAt: number }>();
      const seenTradeIds = new Set<string>();
      for (const trade of account.recentTrades) {
        if (seenTradeIds.has(trade.tradeId)) {
          incomplete ??= 'GATEIO_TRADE_ID_DUPLICATE';
          continue;
        }
        seenTradeIds.add(trade.tradeId);
        const executedAt = trade.createdAtMs;
        if (!Number.isSafeInteger(executedAt) || executedAt <= 0) {
          incomplete ??= 'GATEIO_TRADE_TIME_INVALID';
          continue;
        }
        // Historical exchange facts are retained in the canonical capture, never projected as
        // this run's fill. Exact IDs plus factual server time handle repeated and page-churned history.
        if (bootstrap) {
          if (executedAt >= account.serverTimeMs)
            incomplete ??= 'GATEIO_BOOTSTRAP_TRADE_NOT_HISTORICAL';
          continue;
        }
        if (tradeBoundary !== null) {
          const previous = tradeBoundary.observedTradeFingerprints.get(trade.tradeId);
          if (previous !== undefined) {
            if (previous !== tradeFingerprint(trade))
              incomplete ??= 'GATEIO_HISTORICAL_TRADE_CHANGED';
            continue;
          }
          if (executedAt < tradeBoundary.serverTimeMs) continue;
        }
        const local = trade.clientText === null ? null : byText.get(trade.clientText);
        const quantity = multiplyQuantity(Math.abs(trade.signedSize), facts.contractMultiplier);
        if (!local || !Number.isFinite(quantity) || quantity <= 0
            || local.side !== (trade.signedSize > 0 ? 'buy' : 'sell')
            || (local.preparation
              ? local.execution !== undefined && local.execution.exchangeOrderId !== trade.orderId
              : typeof local.fillId === 'string' && local.fillId !== trade.orderId)) {
          incomplete ??= tradeBoundary === null
            ? 'GATEIO_TRADE_UNCORRELATED' : 'GATEIO_NEW_TRADE_UNCORRELATED';
          continue;
        }
        const previous = tradeGroups.get(trade.orderId);
        if (previous && previous.local.orderId !== local.orderId) {
          incomplete ??= 'GATEIO_TRADE_ORDER_CONFLICT';
          continue;
        }
        tradeGroups.set(trade.orderId, {
          local, quantity: (previous?.quantity ?? 0) + quantity,
          notional: (previous?.notional ?? 0) + quantity * trade.price,
          executedAt: Math.max(previous?.executedAt ?? 0, executedAt),
        });
      }
      const fills: ExternalFill[] = [];
      let lagging = false;
      let currentRunFilledOrders = 0;
      let expectedSignedPosition = 0;
      const executions: OrderExecutionObservation[] = [];
      const lifecycleIds = new Set<string>();
      for (const order of localOrders) {
        if (order.preparation && (order.status === 'SUBMITTED'
            || (order.status === 'FILLED' && account.openOrders.some(open =>
              open.clientText === order.preparation!.clientOrderId
              || open.orderId === order.execution?.exchangeOrderId))
            || (order.execution && (order.execution.status !== 'FILLED'
              || (order.fills?.length ?? 0) > 1 || order.fillId?.includes(':cumulative:'))))) {
          lifecycleIds.add(order.orderId);
          const p = order.preparation;
          const clientText = toGateIoClientText(order.orderId);
          let attested = orderAttestations.get(order.orderId);
          if (attested === undefined || (attested !== null && attested.result.terminal !== true
              && attested.result.status !== 'FINISHED' && attested.result.status !== 'REJECTED')) {
            try { attested = await options.attestCurrentRunOrder?.(clientText, order) ?? null; }
            catch { attested = null; }
            orderAttestations.set(order.orderId, attested);
          }
          try {
            if (!attested || p.clientOrderId !== clientText
                || attested.request.text !== clientText || attested.request.contract !== 'ETH_USDT'
                || attested.result.clientText !== clientText || attested.result.contract !== 'ETH_USDT'
                || attested.request.reduceOnly !== p.reduceOnly || p.reduceOnly !== (order.action !== 'open')
                || !quantityEqual(attested.request.size, (order.side === 'buy' ? 1 : -1) * p.venueQuantity)
                || (attested.result.signedFilledSize !== 0
                  && Math.sign(attested.result.signedFilledSize) !== (order.side === 'buy' ? 1 : -1)))
              throw new Error('ATTRIBUTION');
            if (!openOrdersAgreeWithAttestation(account.openOrders, attested)) {
              incomplete ??= 'GATEIO_OPEN_ORDER_ATTESTATION_CONFLICT';
              continue; // Keep the conflicting open-list evidence; never turn it into MATCH.
            }
            const observation = gateIoOrderExecutionObservation(order.orderId, p, attested.result);
            planExecutionObservation(order, observation);
            const trades = tradeGroups.get(observation.exchangeOrderId);
            if (trades && (!quantityEqual(trades.quantity, observation.cumulativeFilledQuantity)
                || !quantityEqual(trades.notional, observation.cumulativeNotional)))
              throw new Error('TRADE_CONFLICT');
            if (!trades && observation.cumulativeFilledQuantity > 0) lagging = true;
            if (observation.cumulativeFilledQuantity > 0) currentRunFilledOrders += 1;
            expectedSignedPosition += (order.side === 'buy' ? 1 : -1) * observation.cumulativeFilledQuantity;
            executions.push(observation);
            // Merge only after the overlapping facts agree (or prove forward progress).
            const existingIndex = orders.findIndex(o => o.orderId === order.orderId);
            if (existingIndex >= 0) orders.splice(existingIndex, 1);
            orders.push(Object.freeze({ orderId: order.orderId, exchange: 'gateio', symbol: 'ETH/USDT',
              side: order.side, quantity: observation.requestedQuantity,
              status: observation.status === 'SUBMITTED' ? 'OPEN' : observation.status,
              filledQuantity: observation.cumulativeFilledQuantity,
              averageFillPrice: observation.cumulativeFilledQuantity === 0 ? null
                : observation.cumulativeNotional / observation.cumulativeFilledQuantity,
              updatedAt: observation.executedAt }));
            if (observation.cumulativeFilledQuantity > 0) fills.push(Object.freeze({
              fillId: observation.exchangeOrderId, orderId: order.orderId, exchange: 'gateio', symbol: 'ETH/USDT',
              side: order.side, quantity: observation.cumulativeFilledQuantity,
              price: observation.cumulativeNotional / observation.cumulativeFilledQuantity,
              executedAt: observation.executedAt }));
          } catch { incomplete ??= 'GATEIO_CUMULATIVE_ATTESTATION_CONFLICT'; }
          continue;
        }
        if (order.status !== 'FILLED') continue;
        currentRunFilledOrders += 1;
        const clientText = toGateIoClientText(order.orderId);
        const trades = tradeGroups.get(order.fillId!);
        // An already factual personal-trades aggregate keeps the established G3D path.
        // The extra order GET is required only for absent, delayed current-run history.
        if (trades !== undefined && !orderAttestations.has(order.orderId)) {
          const price = trades.notional / trades.quantity;
          if (trades.local.orderId !== order.orderId || !Number.isFinite(price)
              || price <= 0 || !Number.isFinite(trades.quantity)
              || trades.quantity <= 0) {
            incomplete ??= 'GATEIO_TRADE_AGGREGATE_INVALID';
            continue;
          }
          expectedSignedPosition += (order.side === 'buy' ? 1 : -1) * trades.quantity;
          fills.push(Object.freeze({ fillId: order.fillId!, orderId: order.orderId,
            exchange: 'gateio', symbol: 'ETH/USDT', side: order.side,
            quantity: trades.quantity, price, executedAt: trades.executedAt }));
          continue;
        }
        if (!orderAttestations.has(order.orderId)) {
          let observed: GateIoCurrentRunOrderAttestation | null = null;
          try { observed = await options.attestCurrentRunOrder?.(clientText, order) ?? null; }
          catch { /* A failed factual GET is never retried or treated as a fill. */ }
          orderAttestations.set(order.orderId, observed);
        }
        const attested = orderAttestations.get(order.orderId);
        const request = attested?.request;
        const result = attested?.result;
        const reduceOnly = order.action === 'reduce' || order.action === 'close'
          || order.action === 'emergency_exit';
        if (!request || !result || request.text !== clientText
            || request.contract !== 'ETH_USDT' || request.reduceOnly !== reduceOnly
            || request.price !== '0' || request.tif !== 'ioc'
            || !gateIoEthContractSizeValid(request.size)
            || Math.sign(request.size) !== (order.side === 'buy' ? 1 : -1)
            || result.clientText !== clientText || result.contract !== 'ETH_USDT'
            || result.status !== 'FINISHED' || result.tradeId !== order.fillId
            || result.exchangeOrderId !== order.fillId
            || !gateIoEthContractSizeValid(result.signedFilledSize)
            || Math.abs(result.signedFilledSize - request.size) > 1e-10
            || result.averagePrice === null || result.averagePrice <= 0) {
          incomplete ??= result?.status === 'PARTIALLY_FILLED'
            ? 'GATEIO_FILLED_ORDER_ATTESTATION_CONFLICT'
            : 'GATEIO_ORDER_ATTESTATION_UNPROVABLE';
          continue;
        }
        if (!openOrdersAgreeWithAttestation(account.openOrders, attested!)) {
          incomplete ??= 'GATEIO_OPEN_ORDER_ATTESTATION_CONFLICT';
          continue;
        }
        const executedAt = gateIoExecutionSecondsToMilliseconds(result.executedAt);
        const quantity = multiplyQuantity(Math.abs(result.signedFilledSize), facts.contractMultiplier);
        if (executedAt === null || !Number.isFinite(quantity) || quantity <= 0) {
          incomplete ??= 'GATEIO_ORDER_ATTESTATION_UNPROVABLE';
          continue;
        }
        expectedSignedPosition += result.signedFilledSize * facts.contractMultiplier;
        if (trades !== undefined
            && (trades.local.orderId !== order.orderId
              || Math.abs(trades.quantity - quantity) > 1e-10
              || Math.abs(trades.notional / trades.quantity - result.averagePrice) > 1e-8)) {
          incomplete ??= 'GATEIO_ORDER_TRADE_FACTS_CONFLICT';
          continue;
        }
        if (trades === undefined) lagging = true;
        fills.push(Object.freeze({ fillId: order.fillId!, orderId: order.orderId,
          exchange: 'gateio', symbol: 'ETH/USDT', side: order.side,
          quantity, price: result.averagePrice,
          executedAt: trades?.executedAt ?? executedAt }));
      }
      for (const [exchangeOrderId, group] of tradeGroups) {
        if (lifecycleIds.has(group.local.orderId)) continue;
        if (group.local.status === 'FILLED') continue; // exact order already projected once
        const price = group.notional / group.quantity;
        if (!Number.isFinite(group.quantity) || group.quantity <= 0
            || !Number.isFinite(price) || price <= 0) {
          incomplete ??= 'GATEIO_TRADE_AGGREGATE_INVALID';
          continue;
        }
        fills.push(Object.freeze({ fillId: exchangeOrderId, orderId: group.local.orderId,
          exchange: 'gateio', symbol: 'ETH/USDT', side: group.local.side,
          quantity: group.quantity, price, executedAt: group.executedAt }));
      }
      if (lagging || executions.length > 0) {
        const factualSignedPosition = positions.reduce((sum, leg) => sum + leg.signedQuantity, 0);
        if (positions.length > 1 || !Number.isFinite(expectedSignedPosition)
            || Math.abs(expectedSignedPosition - factualSignedPosition) > 1e-10)
          incomplete ??= 'GATEIO_ORDER_POSITION_DELTA_MISMATCH';
      }
      tradeHistory = incomplete !== null ? 'UNKNOWN'
        : currentRunFilledOrders === 0 ? 'NONE' : lagging ? 'LAGGING' : 'CONVERGED';
      latestTruth = Object.freeze({ identity, orders: Object.freeze(orders), fills: Object.freeze(fills),
        ...(executions.length ? { executions: Object.freeze(executions) } : {}),
        positions: Object.freeze(positions), capturedAt, source,
        complete: incomplete === null, ...(incomplete === null ? {} : { incompleteReason: incomplete }) });
      return latestTruth;
    },
  });
}
