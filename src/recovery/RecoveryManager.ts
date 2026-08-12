// Phase 5A: RecoveryManager — open→replay→verify→RECOVERY_VERIFIED
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { FileEventJournal } from './FileEventJournal';
import { replayJournal, type ProjectorMap, type ReplayReport } from './ReplayCoordinator';

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
 *   1. Open journal → load all events
 *   2. Replay → route to projectors
 *   3. Load optional checkpoint, compare anchored to journal sequence
 *   4. Set recoveryVerified internally
 */
export function recoverFromJournal(
  journal: FileEventJournal,
  projectors: ProjectorMap,
  checkpointPath?: string,
): RecoveryResult {
  // Empty journal → no_history
  if (journal.lastSequence === 0) {
    return {
      mode: 'no_history',
      checkpointComparison: 'missing',
      replayReport: { eventsReplayed: 0, lastSequence: 0, errors: [] },
      recoveryVerified: true, // cold start is verified
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

  // Checkpoint validation
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
      // Stale checkpoint → journal authoritative, still verified
    } else {
      // Sequence match → compare digests
      let allMatch = true;
      for (const [name, projList] of projectors) {
        for (const proj of projList) {
          const digest = proj.digest();
          const key = `${name}:${digest}`; // simple composite
          // Compare by iterating all projector digests
          if (cp.digests[name] && cp.digests[name] !== digest) {
            allMatch = false;
          }
        }
      }
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
