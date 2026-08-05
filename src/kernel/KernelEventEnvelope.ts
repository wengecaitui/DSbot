// Phase 1A: KernelEventEnvelope — extends legacy trading event with kernel identity
import type { TradingEventType, TradingEventPayloadMap } from '../events/TradingEvent';

export type KernelEventEnvelope<T extends TradingEventType = TradingEventType> = {
  readonly kernelEventId: string;
  readonly kernelLogicalSequence: number;
  readonly kernelTimestamp: number;
  readonly type: T;
  readonly payload: TradingEventPayloadMap[T];
};
