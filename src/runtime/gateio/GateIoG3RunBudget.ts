/** One explicit G3 verification-run budget. No production trading mandate is implied. */
export interface GateIoG3RunLimits {
  readonly accountAcquisitions: number;
  readonly instrumentAcquisitions: number;
  readonly ambiguousReconciliations: number;
  readonly proofMutations: number;
  readonly cleanupMutations: number;
  readonly totalMutations: number;
  readonly networkRequests: number;
}

export const GATEIO_G3_LIMITS: Readonly<GateIoG3RunLimits> = Object.freeze({
  accountAcquisitions: 5, instrumentAcquisitions: 2,
  ambiguousReconciliations: 2, proofMutations: 2, cleanupMutations: 1,
  totalMutations: 3, networkRequests: 36,
});

export type GateIoG3DenialReason =
  | 'ACCOUNT_TRUTH_ACQUISITION_CAP_EXCEEDED'
  | 'INSTRUMENT_FACTS_ACQUISITION_CAP_EXCEEDED'
  | 'AMBIGUOUS_RECONCILIATION_CAP_EXCEEDED'
  | 'NETWORK_REQUEST_CAP_EXCEEDED'
  | 'MUTATION_PROOF_CAP_EXCEEDED'
  | 'MUTATION_CLEANUP_CAP_EXCEEDED'
  | 'MUTATION_TOTAL_CAP_EXCEEDED'
  | 'CLEANUP_REQUIRES_REDUCE_ONLY';

export class GateIoG3BudgetDenial extends Error {
  readonly decision = 'DENIED' as const;
  constructor(readonly reasonCode: GateIoG3DenialReason) {
    super(reasonCode);
    this.name = 'GateIoG3BudgetDenial';
  }
}

export class GateIoG3RunBudget {
  private accountUsed = 0;
  private instrumentUsed = 0;
  private ambiguousUsed = 0;
  private proofUsed = 0;
  private cleanupUsed = 0;
  private networkUsed = 0;
  readonly limits: Readonly<GateIoG3RunLimits>;

  private constructor(limits: GateIoG3RunLimits) { this.limits = Object.freeze({ ...limits }); }

  static create(limits: GateIoG3RunLimits = GATEIO_G3_LIMITS): GateIoG3RunBudget {
    const keys: readonly (keyof GateIoG3RunLimits)[] = [
      'accountAcquisitions', 'instrumentAcquisitions', 'ambiguousReconciliations',
      'proofMutations', 'cleanupMutations', 'totalMutations', 'networkRequests',
    ];
    if (!limits || !keys.every((key) => Number.isSafeInteger(limits[key]) && limits[key] >= 0)
        || limits.totalMutations > limits.proofMutations + limits.cleanupMutations) {
      throw new Error('GATEIO_G3_BUDGET_INVALID');
    }
    return new GateIoG3RunBudget(limits);
  }

  beginAccountTruth(): void {
    if (this.accountUsed >= this.limits.accountAcquisitions)
      throw new GateIoG3BudgetDenial('ACCOUNT_TRUTH_ACQUISITION_CAP_EXCEEDED');
    this.accountUsed += 1;
  }
  beginInstrumentFacts(): void {
    if (this.instrumentUsed >= this.limits.instrumentAcquisitions)
      throw new GateIoG3BudgetDenial('INSTRUMENT_FACTS_ACQUISITION_CAP_EXCEEDED');
    this.instrumentUsed += 1;
  }
  beginAmbiguousReconciliation(): void {
    if (this.networkUsed >= this.limits.networkRequests)
      throw new GateIoG3BudgetDenial('NETWORK_REQUEST_CAP_EXCEEDED');
    if (this.ambiguousUsed >= this.limits.ambiguousReconciliations)
      throw new GateIoG3BudgetDenial('AMBIGUOUS_RECONCILIATION_CAP_EXCEEDED');
    this.ambiguousUsed += 1;
  }
  consumeReadRequest(): void {
    if (this.networkUsed >= this.limits.networkRequests)
      throw new GateIoG3BudgetDenial('NETWORK_REQUEST_CAP_EXCEEDED');
    this.networkUsed += 1;
  }
  consumeMutationRequest(purpose: 'PROOF' | 'EMERGENCY_CLEANUP', reduceOnly: boolean): void {
    const total = this.proofUsed + this.cleanupUsed;
    if (this.networkUsed >= this.limits.networkRequests)
      throw new GateIoG3BudgetDenial('NETWORK_REQUEST_CAP_EXCEEDED');
    if (total >= this.limits.totalMutations)
      throw new GateIoG3BudgetDenial('MUTATION_TOTAL_CAP_EXCEEDED');
    if (purpose === 'PROOF' && this.proofUsed >= this.limits.proofMutations)
      throw new GateIoG3BudgetDenial('MUTATION_PROOF_CAP_EXCEEDED');
    if (purpose === 'EMERGENCY_CLEANUP' && !reduceOnly)
      throw new GateIoG3BudgetDenial('CLEANUP_REQUIRES_REDUCE_ONLY');
    if (purpose === 'EMERGENCY_CLEANUP' && this.cleanupUsed >= this.limits.cleanupMutations)
      throw new GateIoG3BudgetDenial('MUTATION_CLEANUP_CAP_EXCEEDED');
    if (purpose !== 'PROOF' && purpose !== 'EMERGENCY_CLEANUP')
      throw new Error('GATEIO_G3_PURPOSE_INVALID');
    if (purpose === 'PROOF') this.proofUsed += 1;
    else this.cleanupUsed += 1;
    this.networkUsed += 1;
  }
  snapshot() {
    return Object.freeze({ accountUsed: this.accountUsed, instrumentUsed: this.instrumentUsed,
      ambiguousUsed: this.ambiguousUsed, proofUsed: this.proofUsed,
      cleanupUsed: this.cleanupUsed, totalUsed: this.proofUsed + this.cleanupUsed,
      networkUsed: this.networkUsed });
  }
}
