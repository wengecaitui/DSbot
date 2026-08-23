/**
 * Standalone Phase 7C presentation preview.
 *
 * This process deliberately mounts no ProductionSpine, execution service,
 * agent, channel, or Hermes coordinator. It exists so the read-only UI can be
 * reviewed without an AI provider key; every absent canonical source remains
 * explicitly unavailable.
 */
import { createServer } from '../gateway/server';
import { createWorkbenchRouter } from '../gateway/workbench-routes';
import { createWorkbenchReadAdapter } from '../observability/workbench-read-adapter';

function previewPort(): number {
  const raw = process.env.WORKBENCH_PORT ?? '18790';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`WORKBENCH_PORT must be an integer between 1 and 65535; received ${raw}`);
  }
  return port;
}

async function main(): Promise<void> {
  const port = previewPort();
  const server = createServer({ port, host: '127.0.0.1', cors: false, auth: {} });
  const reads = createWorkbenchReadAdapter({
    now: () => Date.now(),
    runtime: () => ({
      health: 'UNKNOWN',
      environment: 'unknown',
      mode: 'read-only-preview',
    }),
    hermes: () => null,
  });
  server.setWorkbenchRouter(createWorkbenchRouter(reads));

  const stop = async () => {
    await server.stop();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  await server.start();
  console.log('\nDSbot Quant Terminal preview is running.');
  console.log(`Open: http://127.0.0.1:${port}/workbench/`);
  console.log('Mode: READ-ONLY PREVIEW — canonical trading/runtime sources are intentionally UNAVAILABLE.');
  console.log('Press Ctrl+C to stop.\n');
}

main().catch((error) => {
  console.error('Failed to start the Workbench preview:', error);
  process.exitCode = 1;
});
