// Phase 1B2: Policy Snapshot Types
import type { ExchangeId } from '../data/MarketIdentity';

export type PolicyDirection = 'bullish' | 'bearish' | 'neutral' | 'mixed';
export type PolicyRiskLevel = 'low' | 'medium' | 'high';

export interface SymbolPolicyRule {
  readonly allowNewEntries: boolean;
  readonly maxPositionMultiplier: number;
  readonly directionBias: PolicyDirection;
  readonly riskLevel: PolicyRiskLevel;
  readonly allowedStrategyIds: readonly string[];
  readonly blockedStrategyIds: readonly string[];
  readonly reasonCodes: readonly string[];
}

export interface CompiledPolicy {
  readonly exchange: ExchangeId;
  readonly sourceResearchEventId: string;
  readonly sourceResearchSequence: number;
  readonly compilerVersion: string;
  readonly compiledAt: number;
  readonly effectiveAt: number;
  readonly expiresAt: number;
  readonly degradeUntil?: number;
  readonly allowNewEntries: boolean;
  readonly allowedSymbols: readonly string[];
  readonly blockedSymbols: readonly string[];
  readonly allowedStrategyIds: readonly string[];
  readonly blockedStrategyIds: readonly string[];
  readonly maxPositionMultiplier: number;
  readonly riskLevel: PolicyRiskLevel;
  readonly directionBias: PolicyDirection;
  readonly symbolRules: Readonly<Record<string, SymbolPolicyRule>>;
  readonly reasonCodes: readonly string[];
}

export interface VersionedPolicySnapshot extends CompiledPolicy {
  readonly policyId: string;
  readonly policyVersion: number;
  readonly publishedAt: number;
}

export type PolicyStatus = 'missing' | 'active' | 'degraded' | 'expired';

export interface PolicyResolution {
  readonly status: PolicyStatus;
  readonly policy: VersionedPolicySnapshot | null;
  readonly allowNewEntries: boolean;
  readonly maxPositionMultiplier: number;
  readonly directionBias: PolicyDirection;
  readonly riskLevel: PolicyRiskLevel;
  readonly allowedStrategyIds: readonly string[];
  readonly blockedStrategyIds: readonly string[];
  readonly reasonCodes: readonly string[];
}
