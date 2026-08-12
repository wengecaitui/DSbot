// Phase 5A: RecoveryManager — open→replay→verify→RECOVERY_VERIFIED
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { FileEventJournal } from './FileEventJournal';
import { replayJournal, type ProjectorMap, type ReplayReport, type ReplayError } from './ReplayCoordinator';
import { INTERNAL_RECOVERY_SET_SYMBOL, type ProductionSpine } from '../position/ProductionSpine';

export type RecoveryMode = 'verified' | 'failed' | 'no_history';

export interface RecoveryResult {
  mode: RecoveryMode;
  checkpointComparison: 'match' | 'mismatch' | 'stale' | 'missing' | 'inconsistent';
  replayReport: ReplayReport;
  recoveryVerified: boolean;
}

interface CheckpointFile {
  sequence: number;
  digests: Record<string, string>;
}

/**
 * Recovery flow:
 *   1. Open journal → validate all envelopes
 *   2. Replay → route to projectors
 *   3. Load optional checkpoint, compare digests by store name
 *   4. Set recoveryVerified internally on spine
 *   5. Caller then calls spine.start()
 */
export function recoverFromJournal(
  journal: FileEventJournal,
  projectors: ProjectorMap,
  checkpointPath?: string,
  storeDigests?: Record<string, string>,
): RecoveryResult {
  // Empty journal → no_history
  if (journal.lastSequence === 0) {
    return {
      mode: 'no_history',
      checkpointComparison: 'missing',
      replayReport: { eventsReplayed: 0, lastSequence: 0, errors: [] },
      recoveryVerified: true,
    };
  }

  // Validate journal envelopes
  const validationErrors = validateJournal(journal);
  if (validationErrors.length > 0) {
    return {
      mode: 'failed',
      checkpointComparison: 'missing',
      replayReport: { eventsReplayed: 0, lastSequence: journal.lastSequence, errors: validationErrors },
      recoveryVerified: false,
    };
  }

  // Replay
  const replayReport = replayJournal(journal as any, projectors);

  // Replay errors → failed
  if (replayReport.errors.length > 0) {
    return {
      mode: 'failed',
      checkpointComparison: 'missing',
      replayReport,
      recoveryVerified: false,
    };
  }

  // Checkpoint validation using store-name digests
  let checkpointComparison: RecoveryResult['checkpointComparison'] = 'missing';
  if (checkpointPath && existsSync(checkpointPath)) {
    let cp: CheckpointFile;
    try {
      cp = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    } catch {
      return {
        mode: 'failed',
        checkpointComparison: 'inconsistent',
        replayReport,
        recoveryVerified: false,
      };
    }

    if (cp.sequence > journal.lastSequence) {
      return {
        mode: 'failed',
        checkpointComparison: 'inconsistent',
        replayReport,
        recoveryVerified: false,
      };
    }

    if (cp.sequence < journal.lastSequence) {
      checkpointComparison = 'stale';
    } else {
      // Sequence match → compare store-name digests
      const digests = storeDigests ?? {};
      const allMatch = validateCheckpointDigests(cp, digests);
      checkpointComparison = allMatch ? 'match' : 'mismatch';
      if (!allMatch) {
        return {
          mode: 'failed',
          checkpointComparison: 'mismatch',
          replayReport,
          recoveryVerified: false,
        };
      }
    }
  }

  return {
    mode: 'verified',
    checkpointComparison,
    replayReport,
    recoveryVerified: true,
  };
}

/**
 * Set RECOVERY_VERIFIED on a ProductionSpine.
 * Only RecoveryManager should call this — the symbol is exported
 * to prevent caller forgery.
 */
export function grantRecoveryVerified(spine: ProductionSpine): void {
  const fn = (spine as any)[INTERNAL_RECOVERY_SET_SYMBOL];
  if (typeof fn !== 'function') throw new Error('RECOVERY_AUTHORITY: spine has no internal recovery setter');
  fn();
}

/** Save checkpoint for graceful shutdown verification. */
export function saveRecoveryCheckpoint(
  checkpointPath: string,
  journal: FileEventJournal,
  digests: Record<string, string>,
): void {
  const cp: CheckpointFile = {
    sequence: journal.lastSequence,
    digests,
  };
  writeFileSync(checkpointPath, JSON.stringify(cp), 'utf8');
}

/** Validate checkpoint digests against required store names. */
function validateCheckpointDigests(
  cp: CheckpointFile,
  expectedDigests: Record<string, string>,
): boolean {
  const required = ['position', 'market', 'policy', 'oms', 'plan'];
  for (const name of required) {
    if (!(name in cp.digests)) return false; // missing required store
    if (cp.digests[name] !== expectedDigests[name]) return false; // mismatch
  }
  return true;
}

/** Validate journal envelopes: identity, sequence, timestamp, known type, payload. */
function validateJournal(journal: FileEventJournal): ReplayError[] {
  const errors: ReplayError[] = [];
  const envelopes = journal.readFromLogicalSequence(1, 1_000_000);
  for (const env of envelopes) {
    // Valid identity
    if (!env.kernelEventId || typeof env.kernelEventId !== 'string' || env.kernelEventId.length === 0) {
      errors.push({ sequence: env.kernelLogicalSequence, eventId: env.kernelEventId ?? 'missing', message: 'INVALID_ENVELOPE: missing kernelEventId' });
    }
    // Valid sequence
    if (typeof env.kernelLogicalSequence !== 'number' || env.kernelLogicalSequence < 1 || !Number.isSafeInteger(env.kernelLogicalSequence)) {
      errors.push({ sequence: env.kernelLogicalSequence, eventId: env.kernelEventId ?? 'missing', message: `INVALID_ENVELOPE: invalid kernelLogicalSequence=${env.kernelLogicalSequence}` });
    }
    // Valid timestamp
    if (typeof env.kernelTimestamp !== 'number' || env.kernelTimestamp <= 0) {
      errors.push({ sequence: env.kernelLogicalSequence, eventId: env.kernelEventId ?? 'missing', message: `INVALID_ENVELOPE: invalid kernelTimestamp=${env.kernelTimestamp}` });
    }
    // Valid event type
    if (!env.type || typeof env.type !== 'string' || env.type.length === 0) {
      errors.push({ sequence: env.kernelLogicalSequence, eventId: env.kernelEventId, message: 'INVALID_ENVELOPE: missing event type' });
    }
    // Valid payload — must be an object (null is not valid)
    if (env.payload === null || env.payload === undefined || typeof env.payload !== 'object') {
      errors.push({ sequence: env.kernelLogicalSequence, eventId: env.kernelEventId, message: `INVALID_ENVELOPE: payload is ${env.payload === null ? 'null' : typeof env.payload}` });
    }
  }
  return errors;
}
