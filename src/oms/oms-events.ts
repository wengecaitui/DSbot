// Phase 3 OMS: Kernel event types for order lifecycle
import type { OmsOrder } from '../oms/oms-types';

export interface OrderCreatedPayload {
  readonly order: OmsOrder;
}

export interface OrderStatusPayload {
  readonly orderId: string;
  readonly reason?: string;
}
