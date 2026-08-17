/**
 * Phase 7B — narrow Hermes HTTP transport over the existing Express gateway.
 *
 * Mounted at `/api/hermes`, this exposes exactly three authenticated endpoints:
 *
 *   POST /health       — health confirmation / receipt issuance.
 *   POST /instruction  — single-use receipt instruction pull.
 *   GET  /state        — receipt-free state/diagnostic snapshot (counts/status
 *                        only; never exposes token/receipt/instruction).
 *
 * The route names are frozen here and by the tests. Input validation rejects
 * missing/non-string/blank/oversized/malformed receipt material without
 * throwing or leaking internals, mapping deterministically to non-2xx statuses.
 * No token, receipt, or instruction body is ever logged.
 */

import { Router, type Request, type Response } from 'express';
import type { HandshakeCoordinator } from './handshake-coordinator';
import type { FlushNotifier } from './flush-notifier';
import type { BridgeAuthenticator } from './auth';
import type {
  CoordinatorSnapshot,
  FlushNotifierSnapshot,
  PullRejectionReason,
} from './types';

/** Frozen public route contract (see tests/hermes/transport.test.ts). */
export const HERMES_MOUNT_PATH = '/api/hermes';
export const HERMES_HEALTH_ROUTE = '/health';
export const HERMES_INSTRUCTION_ROUTE = '/instruction';
export const HERMES_STATE_ROUTE = '/state';

/** Upper bound on accepted receipt material (defensive; receipts are 48 hex). */
export const DEFAULT_MAX_RECEIPT_LENGTH = 4096;

export interface HermesStateResponse {
  coordinator: CoordinatorSnapshot;
  flush: FlushNotifierSnapshot;
}

export interface HermesTransportOptions {
  coordinator: HandshakeCoordinator;
  notifier: FlushNotifier;
  authenticator: BridgeAuthenticator;
  maxReceiptLength?: number;
}

/**
 * Deterministic non-2xx mapping for coordinator pull rejections. These are the
 * only statuses the pull endpoint can emit for a rejected receipt; they never
 * reveal which receipts are tracked.
 */
export function pullRejectionStatus(reason: PullRejectionReason): number {
  switch (reason) {
    case 'EMPTY_RECEIPT':
      return 400;
    case 'UNKNOWN_RECEIPT':
    case 'EXPIRED_RECEIPT':
    case 'REPLAYED_RECEIPT':
    case 'GENERATION_MISMATCH':
      return 401;
    case 'STOPPED':
    case 'UNHEALTHY':
    case 'TIMED_OUT':
    case 'CIRCUIT_OPEN':
    case 'INSTRUCTION_UNAVAILABLE':
    case 'RECEIPT_UNAVAILABLE':
      return 503;
    default:
      return 503;
  }
}

/**
 * Validate receipt material at the transport boundary. Returns an HTTP status
 * when the input must be rejected (non-2xx), or `null` when it is acceptable.
 */
export function validateReceiptMaterial(
  value: unknown,
  maxReceiptLength: number
): number | null {
  if (value === undefined || value === null) return 400; // missing
  if (typeof value !== 'string') return 400; // non-string
  if (value.trim().length === 0) return 400; // blank
  if (value.length > maxReceiptLength) return 413; // oversized
  return null;
}

export function createHermesTransport(options: HermesTransportOptions): Router {
  const { coordinator, notifier, authenticator } = options;
  const maxReceiptLength =
    options.maxReceiptLength !== undefined && options.maxReceiptLength > 0
      ? options.maxReceiptLength
      : DEFAULT_MAX_RECEIPT_LENGTH;

  const router = Router();

  // Dedicated fail-closed auth, independent of the gateway's requireAuth.
  router.use((req: Request, res: Response, next) => {
    const decision = authenticator.authenticate(req);
    if (!decision.ok) {
      res.status(decision.status ?? 503).json({ error: 'hermes_bridge_unavailable' });
      return;
    }
    next();
  });

  // Health confirmation / receipt issuance.
  router.post(HERMES_HEALTH_ROUTE, async (_req: Request, res: Response) => {
    const result = await coordinator.confirmHealth();
    // 200 only when the health confirmation actually succeeded (a receipt was
    // issued). Every unconfirmed outcome (STOPPED, UNHEALTHY, TIMED_OUT,
    // CIRCUIT_OPEN, RECEIPT_UNAVAILABLE, ...) maps deterministically to 503,
    // while the stable result body is preserved verbatim.
    res.status(result.confirmed ? 200 : 503).json(result);
  });

  // Single-use receipt instruction pull.
  router.post(HERMES_INSTRUCTION_ROUTE, async (req: Request, res: Response) => {
    const body: unknown = req.body;
    const receipt =
      body !== null && typeof body === 'object'
        ? (body as Record<string, unknown>).receipt
        : undefined;

    const validationStatus = validateReceiptMaterial(receipt, maxReceiptLength);
    if (validationStatus !== null) {
      res.status(validationStatus).json({ error: 'invalid_receipt' });
      return;
    }

    const result = await coordinator.pullInstruction(receipt as string);
    if (result.authorized) {
      // Do not echo the receipt back — only the instruction payload.
      res.status(200).json({
        authorized: true,
        generation: result.generation,
        instruction: result.instruction,
      });
      return;
    }

    res.status(pullRejectionStatus(result.reason)).json({
      authorized: false,
      reason: result.reason,
    });
  });

  // Receipt-free state/diagnostic snapshot (counts/status only).
  router.get(HERMES_STATE_ROUTE, (_req: Request, res: Response) => {
    const body: HermesStateResponse = {
      coordinator: coordinator.getSnapshot(),
      flush: notifier.getSnapshot(),
    };
    res.status(200).json(body);
  });

  return router;
}
