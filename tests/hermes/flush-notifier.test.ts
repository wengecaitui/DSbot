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
  const notifier = createFlushNotifier();
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
  assert.equal(bad.error, 'sink down');

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
