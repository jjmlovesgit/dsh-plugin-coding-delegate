// The contract for EventEmitter. Architect-authored: hashed before the unit runs and re-hashed after it,
// so the worker may not touch it and any change to it voids the verdict.
//
// WHAT DISCRIMINATES THIS SUITE. An emitter is a map of listener arrays and almost all of it is
// trivial. The property that is not trivial is SNAPSHOT DISPATCH: emit must iterate the set of
// listeners as it stood when emit was called, so that a callback which removes a listener -- itself or
// another -- cannot shift the array underneath the loop and silently skip the next one.
//
// The naive implementation is one line away from correct and fails in the worst possible way: the
// listener is not called and nothing reports it. Cases 6 and 7 are the cases that reach it, from the
// two directions a snapshot can be violated. The negative fixture is that implementation exactly.
//
// WHY CASE 1 PINS A LOOSE SIGNATURE. Every other contract in this repository pins its exact signature
// text. This one cannot: the natural generic is
// `EventEmitter<Events extends Record<string, (...args: any[]) => void>>`, and a regex over a type
// expression that long rejects correct implementations for spelling it `=> any`, or `Array<...>`, or
// across different line breaks. A false red costs more here than a loose green, so the case requires
// the generic CLASS and its constraint but not the exact tail of the type.
//
// DELIBERATELY UNSPECIFIED, so that no case asserts a behaviour the specification never fixed:
//   - whether `off(event, fn)` removes a listener registered with `once(event, fn)`. Implementations
//     that wrap the listener internally cannot match the original reference, and Node's emitter solves
//     that with a tracked back-reference. Requiring it would be a real invariant, but it is not one
//     this specification states, so it is left out rather than invented.
//   - what happens when a listener THROWS. Propagation, skipping the remaining listeners, and
//     swallowing are all defensible; asserting one would settle an open question by fiat.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require(path.join(__dirname, '..', '..', 'tools', 'event-emitter.ts'));

test('EventEmitter strict specification contract', async (t) => {
  await t.test('enforces a generic class export and only that export', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../tools/event-emitter.ts'), 'utf8');
    assert.match(
      src,
      /export\s+class\s+EventEmitter\s*<\s*[A-Za-z_$][\w$]*\s+extends\s+Record\s*<\s*string\s*,/,
      'Must export a generic class EventEmitter whose parameter is constrained to a record of functions'
    );
    assert.equal((src.match(/^export /gm) || []).length, 1, 'exactly one export');
  });

  await t.test('chains fluently: on, once, off and removeAllListeners all return the instance', () => {
    const em = new EventEmitter();
    const fn = () => {};
    assert.equal(em.on('e', fn), em, 'on returns this');
    assert.equal(em.once('e', fn), em, 'once returns this');
    assert.equal(em.off('e', fn), em, 'off returns this');
    assert.equal(em.removeAllListeners('e'), em, 'removeAllListeners(event) returns this');
    assert.equal(em.removeAllListeners(), em, 'removeAllListeners() returns this');
  });

  await t.test('passes every argument through by reference, and emit reports whether anything ran', () => {
    const em = new EventEmitter();
    const payload = { deep: { value: 1 } };
    let seen = null;
    em.on('e', (...args) => {
      seen = args;
    });

    assert.equal(em.emit('e', 1, payload, 'three'), true, 'a dispatch that ran a listener reports true');
    assert.equal(seen.length, 3, 'every argument is forwarded');
    assert.equal(seen[1], payload, 'arguments are passed by REFERENCE, not cloned or serialised');
    assert.deepEqual(seen[1], { deep: { value: 1 } });

    const empty = new EventEmitter();
    assert.equal(empty.emit('nothing-registered'), false, 'a dispatch with no listeners reports false');
  });

  await t.test('preserves registration order, including duplicate registrations', () => {
    const em = new EventEmitter();
    const calls = [];
    const a = () => calls.push('a');
    const b = () => calls.push('b');

    em.on('x', a);
    em.on('x', b);
    em.on('x', a); // the same function registered twice is two registrations, not one

    em.emit('x');
    assert.deepEqual(calls, ['a', 'b', 'a']);
    assert.equal(em.listenerCount('x'), 3);
  });

  await t.test('once() unregisters BEFORE invoking, so a re-entrant emit cannot call it twice', () => {
    // If the listener is removed after it runs, the inner emit still finds it registered and calls it
    // again -- which is the recursion the once contract exists to prevent.
    const em = new EventEmitter();
    let calls = 0;
    em.once('e', () => {
      calls += 1;
      if (calls === 1) em.emit('e'); // re-entrant
    });

    em.emit('e');
    assert.equal(calls, 1, 'the once listener ran exactly once across both dispatches');
    assert.equal(em.listenerCount('e'), 0, 'and it is gone afterwards');

    assert.equal(em.emit('e'), false, 'a later emit has nothing left to run');
  });

  await t.test('SNAPSHOT: removing a listener during emit does not truncate the dispatch', () => {
    // The discriminator. A loop over the LIVE array sees `splice` shift it and skips whichever listener
    // moved into the current index -- silently, with no error, in the middle of a dispatch.
    const em = new EventEmitter();
    const calls = [];
    const second = () => calls.push('second');
    const third = () => calls.push('third');
    const first = () => {
      calls.push('first');
      em.off('e', second); // the classic: remove ANOTHER listener mid-dispatch
    };

    em.on('e', first);
    em.on('e', second);
    em.on('e', third);

    assert.equal(em.emit('e'), true);
    assert.deepEqual(calls, ['first', 'second', 'third'], 'every listener registered at emit time still ran');

    assert.equal(em.listenerCount('e'), 2, 'and the removal did take effect for the NEXT dispatch');
    calls.length = 0;
    em.emit('e');
    assert.deepEqual(calls, ['first', 'third'], 'second is not called again');
  });

  await t.test('SNAPSHOT: a listener removing ITSELF during emit still lets the rest run', () => {
    const em = new EventEmitter();
    const calls = [];
    const self = () => {
      calls.push('self');
      em.off('e', self);
    };
    const after = () => calls.push('after');

    em.on('e', self);
    em.on('e', after);

    em.emit('e');
    assert.deepEqual(calls, ['self', 'after'], 'removing the CURRENT listener must not skip the next one');
    assert.equal(em.listenerCount('e'), 1);
  });

  await t.test('SNAPSHOT: a listener added during emit does not run in the current dispatch', () => {
    const em = new EventEmitter();
    const calls = [];
    const added = () => calls.push('added');
    let addedOnce = false;
    const adder = () => {
      calls.push('adder');
      if (!addedOnce) {
        addedOnce = true;
        em.on('e', added); // must not run until the NEXT dispatch
      }
    };

    em.on('e', adder);
    em.emit('e');
    assert.deepEqual(calls, ['adder'], 'the dispatch is bounded by the listeners present when it began');

    em.emit('e');
    assert.deepEqual(calls, ['adder', 'adder', 'added'], 'the new listener runs on the next dispatch');
  });

  await t.test('listenerCount reports per event, and removeAllListeners is targeted or global', () => {
    const em = new EventEmitter();
    const f = () => {};
    em.on('a', f);
    em.on('a', f);
    em.on('b', f);

    assert.equal(em.listenerCount('a'), 2);
    assert.equal(em.listenerCount('b'), 1);
    assert.equal(em.listenerCount('never-registered'), 0);

    em.removeAllListeners('a');
    assert.equal(em.listenerCount('a'), 0);
    assert.equal(em.listenerCount('b'), 1, 'a targeted removal must not touch another event');

    em.removeAllListeners();
    assert.equal(em.listenerCount('b'), 0, 'the global removal clears every event');
    assert.equal(em.emit('b'), false);

    // and the emitter is reusable afterwards
    let ran = 0;
    em.on('b', () => {
      ran += 1;
    });
    assert.equal(em.emit('b'), true);
    assert.equal(ran, 1);
  });

  await t.test('off() on a listener that is not registered is a no-op', () => {
    const em = new EventEmitter();
    const registered = () => {};
    const stranger = () => {};
    em.on('e', registered);

    em.off('e', stranger);
    em.off('never-registered', registered);
    assert.equal(em.listenerCount('e'), 1, 'removing something absent must not disturb what is present');

    em.off('e', registered);
    assert.equal(em.listenerCount('e'), 0);
  });

  await t.test('does not expose a corruptible backing store', () => {
    const em = new EventEmitter();
    const calls = [];
    em.on('e', () => calls.push('one'));
    em.on('e', () => calls.push('two'));

    // Walk everything reachable from the instance and destroy any container found. A #private field is
    // not an own property and cannot be reached at all, which is the design this case requires.
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

    const names = new Set(Object.getOwnPropertyNames(em));
    let proto = Object.getPrototypeOf(em);
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
      proto = Object.getPrototypeOf(proto);
    }
    for (const name of names) {
      if (name === 'constructor') continue;
      try {
        corrupt(em[name], 4);
      } catch {
        /* ignore: the point is what survives, not what could be reached */
      }
    }

    assert.equal(em.listenerCount('e'), 2, 'the registrations must survive the attempt');
    assert.equal(em.emit('e'), true, 'and the emitter must still dispatch');
    assert.deepEqual(calls, ['one', 'two'], 'in order, exactly once each');
  });
});
