export type GatewayStartRollbackComponent =
  | 'lifecycle-health'
  | 'production-runtime'
  | 'operations-evidence'
  | 'http-gateway';

export interface GatewayStartRollbackOptions {
  readonly markLifecycleUnhealthy: () => void;
  readonly stopProductionRuntime: () => Promise<void>;
  readonly stopOperationsEvidence: () => Promise<void>;
  readonly stopHttpGateway: () => Promise<void>;
  readonly onFailure?: (component: GatewayStartRollbackComponent, error: unknown) => void;
}

/**
 * Best-effort, ordered compensation for a partially started AppGateway.
 * Each boundary is isolated so one cleanup failure cannot retain later
 * resources. The lifecycle binding remains responsible for rethrowing the
 * original startup error unchanged.
 */
export async function rollbackFailedGatewayStart(options: GatewayStartRollbackOptions): Promise<void> {
  const attempt = async (
    component: GatewayStartRollbackComponent,
    action: () => void | Promise<void>,
  ): Promise<void> => {
    try {
      await action();
    } catch (error) {
      try { options.onFailure?.(component, error); } catch { /* rollback reporting is observational */ }
    }
  };

  await attempt('lifecycle-health', options.markLifecycleUnhealthy);
  await attempt('production-runtime', options.stopProductionRuntime);
  await attempt('operations-evidence', options.stopOperationsEvidence);
  await attempt('http-gateway', options.stopHttpGateway);
}
