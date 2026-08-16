import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createGatewayServer } from '../../src/gateway/server';
import type { GatewayServer } from '../../src/gateway/server';
import {
  createBridgeAuthenticator,
  createFlushNotifier,
  createHandshakeCoordinator,
  createHermesTransport,
} from '../../src/hermes';
import type { FlushNotifier, HandshakeCoordinator, InstructionSupplier } from '../../src/hermes';
import { createClock, createIdFactory, getFreePort } from './helpers';

const TOKEN = 'secret-bridge-token-7b';

interface Harness {
  port: number;
  gateway: GatewayServer;
  coordinator: HandshakeCoordinator;
}

interface HarnessOptions {
  token?: string;
  coordinator?: HandshakeCoordinator;
  notifier?: FlushNotifier;
  instructionSupplier?: InstructionSupplier;
  receiptTtlMs?: number;
  now?: () => number;
}

async function startHermes(options: HarnessOptions = {}): Promise<Harness> {
  const port = await getFreePort();
  const gateway = createGatewayServer({ port, cors: false, auth: {} });
  const coordinator =
    options.coordinator ??
    createHandshakeCoordinator({
      healthCollector: () => 'healthy',
      instructionSupplier: options.instructionSupplier,
      receiptTtlMs: options.receiptTtlMs,
      now: options.now,
    });
  const notifier = options.notifier ?? createFlushNotifier();
  const authenticator = createBridgeAuthenticator({ token: options.token });
  gateway.setHermesRouter(createHermesTransport({ coordinator, notifier, authenticator }));
  await gateway.start();
  return { port, gateway, coordinator };
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

test('no dedicated token makes every endpoint fail closed with 503', async () => {
  const { port, gateway } = await startHermes({ token: undefined });
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/hermes/health`, { method: 'POST' });
    const instruction = await fetch(`http://127.0.0.1:${port}/api/hermes/instruction`, { method: 'POST' });
    const state = await fetch(`http://127.0.0.1:${port}/api/hermes/state`);
    assert.equal(health.status, 503);
    assert.equal(instruction.status, 503);
    assert.equal(state.status, 503);
  } finally {
    await gateway.stop();
  }
});

test('a blank token fails closed with 503', async () => {
  const { port, gateway } = await startHermes({ token: '   ' });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/hermes/state`, {
      headers: auth('anything'),
    });
    assert.equal(res.status, 503);
  } finally {
    await gateway.stop();
  }
});

test('a wrong token is rejected with 401', async () => {
  const { port, gateway } = await startHermes({ token: TOKEN });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/hermes/state`, {
      headers: auth('wrong-token'),
    });
    assert.equal(res.status, 401);
  } finally {
    await gateway.stop();
  }
});

test('query-string credentials are never accepted (no bypass)', async () => {
  const { port, gateway } = await startHermes({ token: TOKEN });
  try {
    const viaQueryToken = await fetch(`http://127.0.0.1:${port}/api/hermes/state?token=${TOKEN}`);
    assert.equal(viaQueryToken.status, 401);

    const viaQueryAuth = await fetch(
      `http://127.0.0.1:${port}/api/hermes/state?authorization=${encodeURIComponent(`Bearer ${TOKEN}`)}`
    );
    assert.equal(viaQueryAuth.status, 401);
  } finally {
    await gateway.stop();
  }
});

test('correct Bearer token authorizes the state endpoint without leaking secrets', async () => {
  const coordinator = createHandshakeCoordinator({
    healthCollector: () => 'healthy',
    instructionSupplier: () => ({ op: 'secret-instruction' }),
    randomId: createIdFactory(),
  });
  await coordinator.start();
  const confirmed = await coordinator.confirmHealth(); // track a receipt
  assert.ok(confirmed.receipt);

  const port = await getFreePort();
  const gateway = createGatewayServer({ port, cors: false, auth: {} });
  const notifier = createFlushNotifier();
  gateway.setHermesRouter(
    createHermesTransport({
      coordinator,
      notifier,
      authenticator: createBridgeAuthenticator({ token: TOKEN }),
    })
  );
  await gateway.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/hermes/state`, { headers: auth(TOKEN) });
    assert.equal(res.status, 200);
    const body = await res.json();

    // Counts/status only: no token, no receipt material, no instruction payload.
    assert.equal(body.token, undefined);
    assert.equal(body.receipt, undefined);
    assert.equal(body.instruction, undefined);
    assert.equal(body.coordinator.receipt, undefined);
    assert.equal(body.coordinator.instruction, undefined);
    assert.equal(typeof body.coordinator.state, 'string');
    assert.equal(typeof body.coordinator.generation, 'number');
    assert.equal(body.coordinator.trackedReceiptCount, 1);
    assert.equal(typeof body.coordinator.consumedReceiptCount, 'number');
    assert.equal(body.flush.error, undefined);
    assert.ok(!JSON.stringify(body).includes(TOKEN));
    assert.ok(!JSON.stringify(body).includes('secret-instruction'));
    assert.ok(!JSON.stringify(body).includes(confirmed.receipt as string));
  } finally {
    await gateway.stop();
  }
});

test('health confirmation issues a receipt when running and healthy', async () => {
  const { port, gateway, coordinator } = await startHermes({ token: TOKEN });
  await coordinator.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/hermes/health`, {
      method: 'POST',
      headers: auth(TOKEN),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.confirmed, true);
    assert.equal(typeof body.receipt, 'string');
    assert.ok(body.receipt.length > 0);
  } finally {
    await gateway.stop();
  }
});

test('an unhealthy collector returns 503 with the stable result body preserved', async () => {
  const coordinator = createHandshakeCoordinator({
    healthCollector: () => 'unhealthy',
  });
  const { port, gateway } = await startHermes({ token: TOKEN, coordinator });
  await coordinator.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/hermes/health`, {
      method: 'POST',
      headers: auth(TOKEN),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    // No receipt was issued; the unconfirmed outcome is deterministically 503.
    assert.equal(body.confirmed, false);
    assert.equal(body.receipt, null);
    assert.equal(body.reason, 'UNHEALTHY');
    // The stable result body is preserved verbatim on the non-2xx path.
    assert.equal(body.state, 'running');
    assert.equal(body.health, 'unhealthy');
    assert.equal(typeof body.generation, 'number');
    assert.equal(typeof body.circuitState, 'string');
  } finally {
    await gateway.stop();
  }
});

test('instruction pull returns a non-null instruction only when a supplier is injected', async () => {
  const { port, gateway, coordinator } = await startHermes({
    token: TOKEN,
    instructionSupplier: () => ({ side: 'buy', size: 1 }),
  });
  await coordinator.start();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/hermes/health`, {
      method: 'POST',
      headers: auth(TOKEN),
    });
    const receipt = (await health.json()).receipt;

    const res = await fetch(`http://127.0.0.1:${port}/api/hermes/instruction`, {
      method: 'POST',
      headers: { ...auth(TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ receipt }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.authorized, true);
    assert.deepEqual(body.instruction, { side: 'buy', size: 1 });
    // The receipt is not echoed back on a successful pull.
    assert.equal(body.receipt, undefined);
  } finally {
    await gateway.stop();
  }
});

test('without a supplier the pull fails closed with INSTRUCTION_UNAVAILABLE', async () => {
  const { port, gateway, coordinator } = await startHermes({ token: TOKEN });
  await coordinator.start();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/hermes/health`, {
      method: 'POST',
      headers: auth(TOKEN),
    });
    const receipt = (await health.json()).receipt;

    const res = await fetch(`http://127.0.0.1:${port}/api/hermes/instruction`, {
      method: 'POST',
      headers: { ...auth(TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ receipt }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.authorized, false);
    assert.equal(body.reason, 'INSTRUCTION_UNAVAILABLE');
  } finally {
    await gateway.stop();
  }
});

test('a receipt can only be pulled once (replay is rejected)', async () => {
  const { port, gateway, coordinator } = await startHermes({
    token: TOKEN,
    instructionSupplier: () => ({ op: 'once' }),
  });
  await coordinator.start();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/hermes/health`, {
      method: 'POST',
      headers: auth(TOKEN),
    });
    const receipt = (await health.json()).receipt;

    const first = await fetch(`http://127.0.0.1:${port}/api/hermes/instruction`, {
      method: 'POST',
      headers: { ...auth(TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ receipt }),
    });
    assert.equal(first.status, 200);

    const replay = await fetch(`http://127.0.0.1:${port}/api/hermes/instruction`, {
      method: 'POST',
      headers: { ...auth(TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ receipt }),
    });
    assert.equal(replay.status, 401);
    const body = await replay.json();
    assert.equal(body.reason, 'REPLAYED_RECEIPT');
  } finally {
    await gateway.stop();
  }
});

test('an expired receipt is rejected with EXPIRED_RECEIPT', async () => {
  const clock = createClock();
  const { port, gateway, coordinator } = await startHermes({
    token: TOKEN,
    instructionSupplier: () => ({ op: 'expiring' }),
    receiptTtlMs: 1_000,
    now: clock.now,
  });
  await coordinator.start();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/hermes/health`, {
      method: 'POST',
      headers: auth(TOKEN),
    });
    const receipt = (await health.json()).receipt;

    clock.advance(2_000); // past the 1s TTL

    const res = await fetch(`http://127.0.0.1:${port}/api/hermes/instruction`, {
      method: 'POST',
      headers: { ...auth(TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ receipt }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.reason, 'EXPIRED_RECEIPT');
  } finally {
    await gateway.stop();
  }
});

test('a stopped coordinator never authorizes over the transport', async () => {
  const { port, gateway, coordinator } = await startHermes({ token: TOKEN });
  // coordinator is never started (stopped / non-authorizing)
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/hermes/health`, {
      method: 'POST',
      headers: auth(TOKEN),
    });
    assert.equal(health.status, 503);
    const hb = await health.json();
    assert.equal(hb.confirmed, false);
    assert.equal(hb.reason, 'STOPPED');

    const pull = await fetch(`http://127.0.0.1:${port}/api/hermes/instruction`, {
      method: 'POST',
      headers: { ...auth(TOKEN), 'content-type': 'application/json' },
      body: JSON.stringify({ receipt: 'not-a-real-receipt' }),
    });
    assert.equal(pull.status, 503);
    const pb = await pull.json();
    assert.equal(pb.reason, 'STOPPED');
  } finally {
    await gateway.stop();
  }
});

test('missing, non-string, blank, and oversized receipt material map to 400/413', async () => {
  const { port, gateway, coordinator } = await startHermes({ token: TOKEN });
  await coordinator.start();
  try {
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/api/hermes/instruction`, {
        method: 'POST',
        headers: { ...auth(TOKEN), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    assert.equal((await post({})).status, 400); // missing
    assert.equal((await post({ receipt: 123 })).status, 400); // non-string
    assert.equal((await post({ receipt: '   ' })).status, 400); // blank
    assert.equal((await post({ receipt: 'x'.repeat(5000) })).status, 413); // oversized
  } finally {
    await gateway.stop();
  }
});
