#!/usr/bin/env node
import { config as loadEnvironment } from 'dotenv';
import * as path from 'node:path';
import { verifyControlCenterRuntime } from '../observability/control-center-runtime-smoke';

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const repoPath = path.resolve(optionValue('--repo') ?? process.cwd());
  const envPath = path.resolve(optionValue('--env-file') ?? path.join(repoPath, 'deployments', 'control-center', '.env'));
  const environment = loadEnvironment({ path: envPath, override: false });
  if (environment.error) {
    console.error(`Unable to load Control Center environment file: ${envPath}`);
    process.exitCode = 2;
    return;
  }
  const receipt = await verifyControlCenterRuntime({ repoPath, envPath });
  console.log(JSON.stringify({
    status: receipt.status,
    commitSha: receipt.repository.commitSha,
    integrationHead: receipt.repository.integrationHead,
    checks: receipt.checks,
    limitations: receipt.limitations,
  }, null, 2));
  if (receipt.status !== 'PASS') process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
