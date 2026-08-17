/**
 * Phase 7B — dedicated Hermes bridge authentication.
 *
 * The /api/hermes endpoints are sensitive and must fail closed independently
 * of the development-friendly `requireAuth` middleware used by the rest of the
 * gateway (which allows access when CLODDS_TOKEN is unset and accepts
 * `?token=` query parameters). This authenticator is intentionally stricter:
 *
 * - A dedicated injected credential (HERMES_BRIDGE_TOKEN) is required.
 * - Missing/blank token => 503 Service Unavailable (fail closed).
 * - Wrong token       => 401 Unauthorized.
 * - Authorization Bearer header ONLY; query-string credentials are never
 *   accepted.
 * - Secrets are compared in constant time (SHA-256 digest + timingSafeEqual).
 * - Tokens are never logged or echoed.
 */

import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

export interface BridgeAuthDecision {
  ok: boolean;
  /** Present only when `ok` is false. */
  status?: 401 | 503;
}

export interface BridgeAuthenticator {
  /** Resolve an Authorization Bearer header to an allow/deny decision. */
  authenticate(req: Request): BridgeAuthDecision;
}

export interface BridgeAuthenticatorOptions {
  /** Dedicated bridge credential. Omit/blank => fail closed (503). */
  token?: string;
}

/** Constant-time equality on fixed-size digests so token length does not leak. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export function createBridgeAuthenticator(
  options: BridgeAuthenticatorOptions = {}
): BridgeAuthenticator {
  const token = typeof options.token === 'string' ? options.token.trim() : '';
  const enabled = token.length > 0;

  return {
    authenticate(req: Request): BridgeAuthDecision {
      if (!enabled) {
        // No dedicated credential configured — the bridge is unavailable.
        return { ok: false, status: 503 };
      }

      const header = req.headers.authorization;
      if (typeof header !== 'string') {
        // No Authorization header at all — never consult query-string.
        return { ok: false, status: 401 };
      }

      const match = /^Bearer\s+(.+)$/i.exec(header.trim());
      if (!match) {
        return { ok: false, status: 401 };
      }

      const provided = match[1];
      if (provided.length === 0) {
        return { ok: false, status: 401 };
      }

      if (!safeEqual(provided, token)) {
        return { ok: false, status: 401 };
      }

      return { ok: true };
    },
  };
}
