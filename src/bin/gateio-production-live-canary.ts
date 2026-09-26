#!/usr/bin/env node
/** Explicit executable boundary. No dotenv, environment secret lookup or default credential path. */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { runGateIoProductionLiveCanary, type GateIoLiveCanaryOptions } from '../runtime/gateio/GateIoProductionLiveCanary';

export function parseGateIoLiveCanaryArguments(argv: readonly string[]) {
  const values = new Map<string, string>();
  const names = new Set(['expected-head', 'environment', 'symbol', 'account-id', 'journal',
    'credential-file', 'max-notional-usd', 'permission-read', 'permission-trade',
    'permission-withdraw', 'permission-rotated']);
  let execute = false;
  for (const arg of argv) {
    if (arg === '--execute' && !execute) { execute = true; continue; }
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match || !names.has(match[1]!) || values.has(match[1]!)) throw new Error('INVALID_ARGUMENTS');
    values.set(match[1]!, match[2]!);
  }
  const options: GateIoLiveCanaryOptions = {
    execute, expectedHead: values.get('expected-head'), environment: values.get('environment'),
    symbol: values.get('symbol'), accountId: values.get('account-id'), journalPath: values.get('journal'),
    maxNotionalUsd: Number(values.get('max-notional-usd')),
    permissions: { READ: values.get('permission-read') === 'true', TRADE: values.get('permission-trade') === 'true',
      // Only the literal false is an attestation of no withdrawal permission.
      WITHDRAW: values.get('permission-withdraw') !== 'false', ROTATED: values.get('permission-rotated') === 'true' },
  };
  return { options, credentialPath: values.get('credential-file') };
}

export async function gateIoLiveCanaryMain(argv: readonly string[], cwd = process.cwd()): Promise<number> {
  try {
    const { options, credentialPath } = parseGateIoLiveCanaryArguments(argv);
    const receipt = await runGateIoProductionLiveCanary(options, {
      async inspectRepository() {
        const git = (args: string[]) => execFileSync('git', args, {
          cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
        }).trim();
        const head = git(['rev-parse', 'HEAD']);
        const clean = git(['status', '--porcelain', '--untracked-files=all']) === '';
        if (resolve(git(['rev-parse', '--show-toplevel'])) !== resolve(__dirname, '../..'))
          throw new Error('EXECUTABLE_REPOSITORY_MISMATCH');
        if (options.journalPath && (!isAbsolute(options.journalPath) || !statSync(options.journalPath).isFile()))
          throw new Error('EXISTING_JOURNAL_REQUIRED');
        return { head, clean };
      },
      async credentialProvider() {
        if (!credentialPath || !isAbsolute(credentialPath)
            || resolve(credentialPath) === resolve(options.journalPath!)
            || !statSync(credentialPath).isFile() || statSync(credentialPath).size > 16_384)
          throw new Error('EXPLICIT_CREDENTIAL_FILE_REQUIRED');
        // Explicit JSON only. No .env parser, path search, fallback, key hash or key length output.
        const value: unknown = JSON.parse(readFileSync(credentialPath, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const record = value as Record<string, unknown>;
        return typeof record.apiKey === 'string' && typeof record.secretKey === 'string'
          ? { apiKey: record.apiKey, secretKey: record.secretKey } : null;
      },
      fetchImpl: (url, init) => fetch(url, { ...init, redirect: 'error' }), now: Date.now,
    });
    process.stdout.write(JSON.stringify(receipt) + '\n');
    return receipt.status === 'PASS' ? 0 : 2;
  } catch {
    process.stdout.write('{"status":"STOP","reason":"INVALID_LOCAL_CONFIGURATION"}\n');
    return 2;
  }
}

if (require.main === module) {
  void gateIoLiveCanaryMain(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
