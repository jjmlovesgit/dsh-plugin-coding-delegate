// The contract for AsyncMutex. Architect-authored: hashed before the unit runs and re-hashed after it,
// so the worker may not touch it and any change to it voids the verdict.
//
// WHAT DISCRIMINATES THIS SUITE. A mutex is a boolean and a queue, and both are trivial to write
// wrongly in a way that never throws. The defect this contract is built to reach is the RELEASE ORDER:
// an implementation that unlocks first and *then* wakes the next waiter leaves a window in which a
// fresh `acquire()` sees a free lock and takes it, so the waiter that had been queued and the newcomer
// both hold the mutex at once. Nothing rejects, nothing logs, and mutual exclusion -- the one property
// the class exists for -- is gone.
//
// The correct shape is a HAND-OFF: releasing transfers ownership directly to the next waiter, and the
// lock is never briefly free while a waiter is queued.
//
// The same class of mistake makes a double `release()` destructive: if the release function is not
// idempotent, calling it twice hands the lock to two waiters.
//
// ASYNC ASSERTIONS WITHOUT ARBITRARY TIMEOUTS. A pending promise cannot be asserted on directly without
// waiting some bounded time, and a timing-based bound is exactly the flakiness this repository avoids.
// Every "must still be waiting" assertion here drains a FIXED number of microtasks instead: an
// implementation that grants the lock does so within a handful of microtasks, and one that does not
// would never settle, so ten drains separate the two cases deterministically.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AsyncMutex } = require(path.join(__dirname, '..', '..', 'tools', 'async-mutex.ts'));

/** Drain microtasks. A grant settles inside these; a withheld lock would not settle at all. */
async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** A macrotask hop, for the cases that must let real async work interleave. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('AsyncMutex strict specification contract', async (t) => {
  await t.test('enforces the class export and only that export', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../tools/async-mutex.ts'), 'utf8');
    assert.match(src, /export\s+class\s+AsyncMutex\b/, 'Must export class AsyncMutex');
    assert.equal((src.match(/^export /gm) || []).length, 1, 'exactly one export');
  });

  await t.test('an uncontended acquire resolves, and reports the lock as held', async () => {
    const mutex = new AsyncMutex();
    assert.equal(mutex.isLocked, false);

    const release = await mutex.acquire();
    assert.equal(typeof release, 'function', 'acquire resolves with a release function');
    assert.equal(mutex.isLocked, true);

    release();
    assert.equal(mutex.isLocked, false, 'release frees the lock');
    assert.equal(mutex.queueLength, 0);
  });

  await t.test('a second acquire WAITS: the lock is not held twice', async () => {
    const mutex = new AsyncMutex();
    const first = await mutex.acquire();

    let granted = false;
    const second = mutex.acquire().then((release) => {
      granted = true;
      return release;
    });

    await settle();
    assert.equal(granted, false, 'a second acquire must not resolve while the lock is held');
    assert.equal(mutex.queueLength, 1, 'and it is visible as a waiter');

    first();
    const secondRelease = await second;
    assert.equal(granted, true, 'the waiter is granted once the holder releases');
    assert.equal(mutex.queueLength, 0, 'and it is no longer counted as waiting');

    secondRelease();
    assert.equal(mutex.isLocked, false);
  });

  await t.test('HAND-OFF: a release with a waiter queued never leaves the lock free', async () => {
    // The discriminator. After the first release the lock must belong to the QUEUED waiter immediately,
    // so an acquire issued in the same synchronous turn queues behind it instead of barging in. An
    // implementation that unlocks and then wakes the waiter leaves exactly that window open, and two
    // holders run at once.
    const mutex = new AsyncMutex();
    const first = await mutex.acquire();

    const queued = mutex.acquire(); // waiting

    first(); // release: ownership must transfer to `queued` inside this call

    let barged = false;
    const latecomer = mutex.acquire().then((release) => {
      barged = true;
      // MUST return it. The first version of this case dropped the release function here, so the
      // awaited value was undefined and the call below threw -- rejecting a CORRECT implementation on
      // a TypeError rather than on the property. The fixture still failed this case for the right
      // reason, which is exactly why the discrimination pre-flight cannot be the only check: it proves
      // the contract rejects a bad module, not that it accepts a good one.
      return release;
    });

    await settle();
    assert.equal(barged, false, 'an acquire must not barge ahead of a waiter that already holds the transfer');
    assert.equal(mutex.isLocked, true, 'the lock is held by the queued waiter, never briefly free');

    const queuedRelease = await queued;
    queuedRelease();

    const latecomerRelease = await latecomer;
    assert.equal(barged, true, 'the latecomer runs only after the queued waiter releases');
    latecomerRelease();
  });

  await t.test('release is IDEMPOTENT: a double release does not admit two waiters', async () => {
    // If the release function can be spent twice, the second call wakes another waiter while the first
    // is still running -- mutual exclusion broken by a caller that releases defensively.
    const mutex = new AsyncMutex();
    const first = await mutex.acquire();
    const second = mutex.acquire();
    const third = mutex.acquire();

    first();
    first(); // must be a no-op
    first(); // and again

    const secondRelease = await second;

    // NOTE: no isLocked assertion here. "The lock reads as held after a hand-off" is the HAND-OFF
    // property and it belongs to that case; asserting it here made this case fail for a reason that is
    // not idempotency. Measured: with the assertion present, the hand-off fixture failed this case too.
    let thirdGranted = false;
    third.then(() => {
      thirdGranted = true;
    });
    await settle();
    assert.equal(thirdGranted, false, 'the third waiter must still be waiting after a triple release');

    secondRelease();
    const thirdRelease = await third;
    assert.equal(thirdGranted, true);
    thirdRelease();
    assert.equal(mutex.isLocked, false);
    assert.equal(mutex.queueLength, 0);
  });

  await t.test('waiters are granted FIFO', async () => {
    const mutex = new AsyncMutex();
    const first = await mutex.acquire();
    const order = [];

    const second = mutex.acquire().then((r) => {
      order.push('a');
      return r;
    });
    const third = mutex.acquire().then((r) => {
      order.push('b');
      return r;
    });
    const fourth = mutex.acquire().then((r) => {
      order.push('c');
      return r;
    });
    assert.equal(mutex.queueLength, 3);

    first();
    (await second)();
    (await third)();
    (await fourth)();

    assert.deepEqual(order, ['a', 'b', 'c'], 'waiters are served in the order they arrived');
  });

  await t.test('runExclusive serialises its callback and returns its value', async () => {
    const mutex = new AsyncMutex();
    const trace = [];

    const one = mutex.runExclusive(async () => {
      trace.push('one:start');
      await tick();
      trace.push('one:end');
      return 1;
    });
    const two = mutex.runExclusive(() => {
      trace.push('two:start');
      trace.push('two:end');
      return 2;
    });

    assert.deepEqual(await Promise.all([one, two]), [1, 2]);
    assert.deepEqual(
      trace,
      ['one:start', 'one:end', 'two:start', 'two:end'],
      'the second callback must not begin until the first has finished'
    );
    assert.equal(mutex.isLocked, false, 'the lock is released afterwards');
  });

  await t.test('runExclusive releases the lock when its callback THROWS', async () => {
    const mutex = new AsyncMutex();
    await assert.rejects(
      () =>
        mutex.runExclusive(async () => {
          throw new Error('boom');
        }),
      /boom/
    );

    assert.equal(mutex.isLocked, false, 'a throwing callback must not strand the lock');
    const release = await mutex.acquire();
    release();
  });

  await t.test('never admits two holders under contention', async () => {
    const mutex = new AsyncMutex();
    let active = 0;
    let peak = 0;

    const tasks = [];
    for (let i = 0; i < 25; i += 1) {
      tasks.push(
        mutex.runExclusive(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await tick();
          active -= 1;
        })
      );
    }
    await Promise.all(tasks);

    assert.equal(peak, 1, 'at most one holder at any moment across 25 contending tasks');
    assert.equal(active, 0);
    assert.equal(mutex.isLocked, false);
    assert.equal(mutex.queueLength, 0);
  });

  await t.test('does not expose a corruptible backing store', async () => {
    const mutex = new AsyncMutex();
    const release = await mutex.acquire();

    const seen = new Set();
    const corrupt = (value, depth) => {
      if (value === null || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.length = 0;
        value.push('CORRUPT');
        return;
      }
      if (value instanceof Map || value instanceof Set) {
        value.clear();
        return;
      }
      if (depth <= 0) return;
      for (const key of Object.getOwnPropertyNames(value)) {
        try {
          corrupt(value[key], depth - 1);
        } catch {
          /* an accessor that refuses to be read leaves nothing to corrupt */
        }
      }
    };

    const names = new Set(Object.getOwnPropertyNames(mutex));
    let proto = Object.getPrototypeOf(mutex);
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
      proto = Object.getPrototypeOf(proto);
    }
    for (const name of names) {
      if (name === 'constructor') continue;
      try {
        corrupt(mutex[name], 4);
      } catch {
        /* ignore: the point is what survives, not what could be reached */
      }
    }

    assert.equal(mutex.isLocked, true, 'the held lock must survive the attempt');
    release();

    // and the mutex is fully usable afterwards
    const again = await mutex.acquire();
    assert.equal(mutex.isLocked, true);
    again();
    assert.equal(mutex.isLocked, false);
  });
});
