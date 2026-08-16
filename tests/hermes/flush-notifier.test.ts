import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlushNotifier } from '../../src/hermes';
import type { FlushNotification } from '../../src/hermes';
import { createClock } from './helpers';

test('revisions are strictly monotonic across serial and concurrent flushes', async () => {
  const notifier = createFlushNotifier();
  assert.equal(notifier.getRevision(), 0);

  const r1 = await notifier.flush({ key: 'a' });
  const r2 = await notifier.flush({ key: 'b' });
  assert.deepEqual([r1.revision, r2.revision], [1, 2]);

  // Concurrent flushes must not collide.
  const [r3, r4] = await Promise.all([notifier.flush(), notifier.flush()]);
  const revisions = [r3.revision, r4.revision].sort((a, b) => a - b);
  assert.deepEqual(revisions, [3, 4]);
  assert.equal(notifier.getRevision(), 4);
});

test('duplicate and stale revisions cannot be presented as fresh', async () => {
  const notifier = createFlushNotifier({ sink: () => {} }); // acknowledging sink
  await notifier.flush();
  await notifier.flush();
  assert.equal(notifier.getRevision(), 2);
  assert.equal(notifier.isFresh(2), true);
  assert.equal(notifier.isFresh(1), false); // stale
  assert.equal(notifier.isFresh(0), false); // never flushed
  assert.equal(notifier.isFresh(999), false); // future/invalid
});

test('sink failure is contained, revision still advances, and it is observable', async () => {
  const clock = createClock();
  let fail = false;
  const delivered: FlushNotification[] = [];
  const notifier = createFlushNotifier({
    now: clock.now,
    sink: async (n: FlushNotification) => {
      if (fail) throw new Error('sink down');
      delivered.push(n);
    },
  });

  const ok = await notifier.flush('first');
  assert.equal(ok.acknowledged, true);
  assert.equal(ok.revision, 1);

  fail = true;
  const bad = await notifier.flush('second');
  assert.equal(bad.acknowledged, false);
  assert.equal(bad.revision, 2);
  assert.equal(bad.error, 'SINK_FAILED');

  const snap = notifier.getSnapshot();
  assert.equal(snap.revision, 2);
  assert.equal(snap.failures, 1);
  assert.equal(snap.lastAcknowledged, false);

  // Still monotonic after a failure.
  fail = false;
  const ok2 = await notifier.flush('third');
  assert.equal(ok2.revision, 3);
  assert.equal(delivered.map(d => d.revision).join(','), '1,3');
});

test('flush notification carries revision, timestamp, and payload', async () => {
  const clock = createClock();
  const seen: FlushNotification[] = [];
  const notifier = createFlushNotifier({
    now: clock.now,
    sink: n => seen.push(n),
  });
  await notifier.flush({ providers: ['bitget'] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].revision, 1);
  assert.equal(seen[0].flushedAt, 1_000_000);
  assert.deepEqual(seen[0].payload, { providers: ['bitget'] });
});

test('flush notifier snapshot is frozen', async () => {
  const notifier = createFlushNotifier();
  await notifier.flush();
  const snap = notifier.getSnapshot();
  assert.ok(Object.isFrozen(snap));
});

test('no configured sink fails closed with a stable NO_SINK error', async () => {
  const notifier = createFlushNotifier(); // no sink
  const result = await notifier.flush({ k: 1 });
  assert.equal(result.acknowledged, false);
  assert.equal(result.revision, 1);
  assert.equal(result.error, 'NO_SINK');
  const snap = notifier.getSnapshot();
  assert.equal(snap.lastAcknowledged, false);
  assert.equal(snap.failures, 1);
});

test('a failed latest flush is never considered fresh', async () => {
  let fail = false;
  const notifier = createFlushNotifier({
    sink: async () => { if (fail) throw new Error('down'); },
  });
  await notifier.flush(); // revision 1, acknowledged
  assert.equal(notifier.isFresh(1), true);

  fail = true;
  await notifier.flush(); // revision 2, failed
  assert.equal(notifier.getRevision(), 2);
  assert.equal(notifier.isFresh(2), false); // latest but unacknowledged
  assert.equal(notifier.isFresh(1), false); // stale

  fail = false;
  await notifier.flush(); // revision 3, acknowledged
  assert.equal(notifier.isFresh(3), true);
  assert.equal(notifier.isFresh(2), false); // past failed revision
});

test('a never-resolving sink times out as an unacknowledged failure, preserving revisions', async () => {
  const notifier = createFlushNotifier({
    sinkTimeoutMs: 50,
    sink: () => new Promise<void>(() => {}), // never resolves
  });
  const result = await notifier.flush();
  assert.equal(result.acknowledged, false);
  assert.equal(result.revision, 1);
  assert.equal(result.error, 'SINK_TIMEOUT');
  assert.equal(notifier.getRevision(), 1); // monotonic preserved
  assert.equal(notifier.isFresh(1), false);
});

test('the notifier recovers to acknowledged after a timeout', async () => {
  let hang = true;
  const notifier = createFlushNotifier({
    sinkTimeoutMs: 50,
    sink: () => (hang ? new Promise<void>(() => {}) : undefined),
  });
  const bad = await notifier.flush();
  assert.equal(bad.acknowledged, false);
  assert.equal(bad.error, 'SINK_TIMEOUT');

  hang = false;
  const good = await notifier.flush();
  assert.equal(good.acknowledged, true);
  assert.equal(good.revision, 2);
  assert.equal(notifier.isFresh(2), true);
});

test('a throwing sink never leaks its error text; it reports a stable SINK_FAILED code', async () => {
  const notifier = createFlushNotifier({
    sink: () => {
      throw new Error('secret: api_key=sk-live-1234567890');
    },
  });
  const result = await notifier.flush();
  assert.equal(result.acknowledged, false);
  assert.equal(result.revision, 1);
  assert.equal(result.error, 'SINK_FAILED');
  assert.ok(!result.error?.includes('sk-live'));
  assert.ok(!result.error?.includes('secret'));
});
