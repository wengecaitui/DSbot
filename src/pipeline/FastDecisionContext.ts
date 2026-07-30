/**
 * Stage 4B4.1: FastDecisionContext — structural readonly port for FastPipeline.
 *
 * This is a structural type, not a class. The real ExecutionRouter satisfies it
 * without an explicit `implements` clause — TypeScript's structural typing handles
 * the compatibility check at call sites.
 *
 * No imports of ExecutionRouter, KillSwitch, or any router internals.
 * No route, execute, order, lock, unlock, update, snapshot, adapter, or mutation methods.
 */
import type { ExchangeId } from '../data/MarketIdentity';
import type { MarketBiasReportFull } from '../types/market-bias';

export interface FastDecisionContext {
  /** Exchange this context is bound to. */
  readonly exchange: ExchangeId;

  /** Current MarketBiasReport, or null if none loaded. */
  getBiasReport(): MarketBiasReportFull | null;

  /** Configuration — only maxBiasReportAgeHours is exposed to FastPipeline. */
  getConfig(): { readonly maxBiasReportAgeHours: number };

  /**
   * Optional kill switch narrow interface.
   * The real KillSwitch structurally satisfies this — no explicit implements needed.
   */
  readonly killSwitch?: {
    /** Read-only lock state query — no numeric risk check. */
    getLockState(exchange: ExchangeId): { readonly locked: boolean; readonly reason?: string };

    /** Total capital for position sizing. */
    getConfig(): { readonly totalCapitalUsd: number };

    /** Risk admission check. */
    check(
      exchange: ExchangeId,
      symbol: string,
      positionUsd: number,
    ): { readonly allowed: boolean; readonly reason?: string };
  };
}
