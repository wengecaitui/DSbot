import type { PositionResolution } from '../types/position-state';
import type { TradeIntent } from '../types/trade-intent';
import type { AccountBoundHardRiskSnapshot, GatewayResult, TradeAction } from './pretrade-risk-types';
import { generateOrderId } from '../oms/order-id';

export interface TrustedExitProof {
  readonly effect: 'REDUCE' | 'CLOSE' | 'EMERGENCY_CLOSE';
  readonly exchange: 'gateio';
  readonly settle: 'USDT';
  readonly accountId: string;
  readonly symbol: string;
  readonly direction: 'long' | 'short';
  readonly exposureQuantityExact: string;
  readonly valuationPriceExact: string;
  readonly positionVersion: number;
  readonly positionSourceKernelEventId: string;
  readonly truthCapturedAt: number;
  readonly truthSource: string;
  readonly reduceOnly: true;
  readonly orderId: string;
}

// Compare decimal facts without float multiplication, division, epsilon, or uplift.
function decimal(value: number | string): { coefficient: bigint; scale: number } {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) throw new Error('EXIT_DECIMAL_INVALID');
  const fraction = match[2] ?? '';
  let scale = fraction.length - Number(match[3] ?? 0);
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 1000) throw new Error('EXIT_DECIMAL_INVALID');
  let coefficient = BigInt(match[1]! + fraction);
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  return { coefficient, scale };
}
export function exitExact(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error('EXIT_DECIMAL_INVALID');
  const { coefficient, scale } = decimal(value);
  if (scale === 0) return String(coefficient);
  const digits = String(coefficient).padStart(scale + 1, '0');
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return digits.slice(0, -scale) + (fraction ? '.' + fraction : '');
}
export function compareExitProduct(quantity: number | string, price: number | string,
  notional: number | string): number {
  const q = decimal(quantity), p = decimal(price), n = decimal(notional);
  const scale = Math.max(q.scale + p.scale, n.scale);
  const left = q.coefficient * p.coefficient * 10n ** BigInt(scale - q.scale - p.scale);
  const right = n.coefficient * 10n ** BigInt(scale - n.scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Pure sizing proof. Readiness and provenance are established by the private runtime boundary. */
export function deriveTrustedExit(input: {
  intent: TradeIntent; requestedAction: TradeAction; position: PositionResolution;
  accountId: string; hardRisk: AccountBoundHardRiskSnapshot; valuationPrice: number;
  truthCapturedAt: number; truthSource: string;
}): { result: GatewayResult; action: TradeAction; proof: TrustedExitProof | null } {
  const { intent, position, hardRisk } = input;
  const deny = (reasonCode: Extract<GatewayResult, { decision: 'REJECTED' }>['reasonCode']) =>
    ({ result: { decision: 'REJECTED' as const, reasonCode }, action: input.requestedAction, proof: null });
  if (hardRisk.exchange !== 'gateio' || hardRisk.accountId !== input.accountId
      || intent.exchange !== 'gateio' || intent.symbol !== 'ETH/USDT') return deny('PROVENANCE_MISMATCH');
  if (!['reduce', 'close', 'emergency_exit'].includes(input.requestedAction)) return deny('INVALID_INPUT');
  if (hardRisk.mutationHalt === 'ALL_MUTATIONS') return deny('ALL_MUTATIONS_HALTED');
  if (hardRisk.mutationHalt !== undefined && hardRisk.mutationHalt !== 'RISK_INCREASE')
    return deny('HARD_RISK_CONFIG_INVALID');
  const p = position.snapshot;
  if (position.status !== 'open' || !p || p.exchange !== intent.exchange || p.symbol !== intent.symbol
      || !Number.isSafeInteger(p.positionVersion) || p.positionVersion <= 0
      || !/^[a-f0-9]{64}$/.test(p.sourceKernelEventId)
      || !Number.isFinite(position.signedQuantity) || position.signedQuantity === 0
      || p.signedQuantity !== position.signedQuantity
      || (position.side === 'long') !== (position.signedQuantity > 0)) return deny('POSITION_UNKNOWN');
  if (input.requestedAction === 'open' || !['long', 'short'].includes(intent.direction)
      || intent.direction === position.side) return deny('ACTION_POSITION_CONFLICT');
  if (!Number.isFinite(input.valuationPrice) || input.valuationPrice <= 0
      || !Number.isFinite(intent.positionUsd) || intent.positionUsd <= 0
      || intent.orderType !== 'market') return deny('INVALID_INPUT');
  const comparison = compareExitProduct(Math.abs(position.signedQuantity), input.valuationPrice, intent.positionUsd);
  if (comparison < 0) return deny('EXIT_QUANTITY_EXCEEDS_EXPOSURE');
  const effect = comparison > 0 ? 'REDUCE'
    : input.requestedAction === 'emergency_exit' ? 'EMERGENCY_CLOSE' : 'CLOSE';
  const action = effect === 'REDUCE' ? 'reduce' : effect === 'CLOSE' ? 'close' : 'emergency_exit';
  const proof: TrustedExitProof = Object.freeze({ effect, exchange: 'gateio', settle: 'USDT',
    accountId: input.accountId, symbol: intent.symbol, direction: intent.direction,
    exposureQuantityExact: exitExact(Math.abs(position.signedQuantity)),
    valuationPriceExact: exitExact(input.valuationPrice), positionVersion: p.positionVersion,
    positionSourceKernelEventId: p.sourceKernelEventId, truthCapturedAt: input.truthCapturedAt,
    truthSource: input.truthSource, reduceOnly: true,
    orderId: generateOrderId({ ...intent, action, approvedPositionUsd: intent.positionUsd }) });
  return { action, proof, result: Object.freeze({ decision: 'ADMITTED', action, intent,
    approvedPositionUsd: intent.positionUsd }) };
}
