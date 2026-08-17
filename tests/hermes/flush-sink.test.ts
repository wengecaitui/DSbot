import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpFlushSink } from '../../src/hermes';
import { getFreePort } from './helpers';

function listen(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, () => {
      const address = server.address() as AddressInfo;
      resolve({ server, port: address.port });
    });
    server.on('error', reject);
  });
}

test('a 2xx response acknowledges the flush sink', async () => {
  const seen: unknown[] = [];
  const { server, port } = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      seen.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  try {
    const sink = createHttpFlushSink(`http://127.0.0.1:${port}/flush`);
    await sink({ revision: 1, flushedAt: 42 });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { revision: 1, flushedAt: 42 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a non-2xx response rejects without echoing the response body', async () => {
  const { server, port } = await listen((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'secret-internal-detail' }));
  });

  try {
    const sink = createHttpFlushSink(`http://127.0.0.1:${port}/flush`);
    await assert.rejects(
      sink({ revision: 1, flushedAt: 42 }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'FLUSH_SINK_HTTP_500');
        assert.ok(!err.message.includes('secret-internal-detail'));
        return true;
      }
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
