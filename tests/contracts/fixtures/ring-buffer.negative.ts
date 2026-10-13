// NEGATIVE FIXTURE - never imported by the module under test, only by the discrimination gate.
//
// It is deliberately PLAUSIBLE. Capacity validation is right, the store is a #private field so it
// cannot be reached, and FIFO order is right -- for as long as nothing wraps. It is wrong in exactly
// one respect: the bound is never enforced, so `push` always accepts and the backing array grows past
// `capacity`. That is the most likely wrong answer to this specification, because a plain array with
// push/shift satisfies every property a ring buffer has until the first wrap.
//
// Expected, MEASURED in the pre-flight rather than assumed: the contract passes the signature,
// capacity-validation, empty-boundary, FIFO-within-capacity, slot-recovery and encapsulation cases, and
// FAILS exactly two -- "refuses a push into a full buffer and changes nothing", and "stays FIFO and
// bounded across many cycles against a model".
//
// The first draft of this fixture claimed the slot-recovery case would catch it too. It does not: once
// a pop has made room, a shift-then-push is indistinguishable from a ring reuse, so that case passes
// here. The bound is the observable consequence of wrapping, and the bound is where this is caught.
export class RingBuffer<T> {
  #items: T[] = [];
  #capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        'RingBuffer capacity must be a positive integer, received ' + String(capacity)
      );
    }
    this.#capacity = capacity;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get size(): number {
    return this.#items.length;
  }

  isEmpty(): boolean {
    return this.#items.length === 0;
  }

  isFull(): boolean {
    return this.#items.length >= this.#capacity;
  }

  peek(): T | undefined {
    return this.#items.length === 0 ? undefined : this.#items[0];
  }

  push(item: T): boolean {
    // THE DEFECT. The bound is never checked, so the buffer silently grows past its capacity and the
    // caller is told every write was stored.
    this.#items.push(item);
    return true;
  }

  pop(): T | undefined {
    return this.#items.shift();
  }
}
