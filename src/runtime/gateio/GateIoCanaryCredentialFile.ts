/** Explicit CLI file boundary only. Never searches for or discovers credentials. */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { GateIoReadCredential } from './GateIoReadContracts';

type Denial = 'CREDENTIAL_INSIDE_GIT_WORKTREE' | 'CREDENTIAL_CONTAINMENT_UNVERIFIED'
  | 'EXPLICIT_CREDENTIAL_FILE_REQUIRED';
export class GateIoCanaryCredentialError extends Error {
  constructor(readonly code: Denial) { super(code); }
}

/** Narrow filesystem seam for offline containment probes; production uses the native operations. */
export interface GateIoCredentialFileAccess {
  realpath(value: string): string;
  stat(value: string): { isFile(): boolean; size: number };
  readText(value: string): string;
}
const nativeAccess: GateIoCredentialFileAccess = {
  realpath: realpathSync.native, stat: statSync, readText: value => readFileSync(value, 'utf8'),
};

export function isInsideGateIoGitWorktree(file: string, root: string,
  paths: Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'> = path): boolean {
  const relative = paths.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + paths.sep)
    && !paths.isAbsolute(relative));
}

export function readGateIoCanaryCredentialFile(credentialPath: string | undefined, journalPath: string,
  git: (args: string[]) => string, access: GateIoCredentialFileAccess = nativeAccess): GateIoReadCredential | null {
  try {
    if (!credentialPath || !path.isAbsolute(credentialPath))
      throw new GateIoCanaryCredentialError('EXPLICIT_CREDENTIAL_FILE_REQUIRED');
    // NUL porcelain preserves spaces, Unicode, newlines and unquoted Windows paths.
    const currentRoot = git(['rev-parse', '--show-toplevel']).trimEnd();
    const listedRoots = git(['worktree', 'list', '--porcelain', '-z']).split('\0')
      .filter(field => field.startsWith('worktree ')).map(field => field.slice('worktree '.length));
    if (!listedRoots.length || ![currentRoot, ...listedRoots].every(root => path.isAbsolute(root)))
      throw new GateIoCanaryCredentialError('CREDENTIAL_CONTAINMENT_UNVERIFIED');
    // Canonicalize EVERY root, including other linked checkouts, before reading any secret bytes.
    // A missing/inaccessible worktree cannot silently weaken the protected set.
    const roots = [currentRoot, ...listedRoots].map(root => access.realpath(root));
    const realFile = access.realpath(credentialPath);
    if (roots.some(root => isInsideGateIoGitWorktree(realFile, root)))
      throw new GateIoCanaryCredentialError('CREDENTIAL_INSIDE_GIT_WORKTREE');
    if (path.relative(access.realpath(journalPath), realFile) === '')
      throw new GateIoCanaryCredentialError('EXPLICIT_CREDENTIAL_FILE_REQUIRED');
    const stat = access.stat(realFile);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > 16_384)
      throw new GateIoCanaryCredentialError('EXPLICIT_CREDENTIAL_FILE_REQUIRED');
    const value: unknown = JSON.parse(access.readText(realFile));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return typeof record.apiKey === 'string' && typeof record.secretKey === 'string'
      ? { apiKey: record.apiKey, secretKey: record.secretKey } : null;
  } catch (error) {
    if (error instanceof GateIoCanaryCredentialError) throw error;
    // Never retain filesystem/Git errors, paths, JSON fragments, or their original objects.
    throw new GateIoCanaryCredentialError('CREDENTIAL_CONTAINMENT_UNVERIFIED');
  }
}
