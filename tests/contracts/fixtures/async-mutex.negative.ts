// NEGATIVE FIXTURE - never imported by the module under test, only by the discrimination gate.
//
// It is deliberately PLAUSIBLE, and it has exactly ONE defect: releasing unlocks the mutex and THEN
// wakes the next waiter, without transferring ownership. Between those two statements nothing runs --
// JavaScript is single-threaded -- so the defect is not a race in the usual sense. It is a WINDOW: by
// the time the release call returns, the mutex reads as free while a waiter has already been handed the
// lock, and the next `acquire()` in that same synchronous turn takes it.
//
// Everything else is correct, so the failure isolates the property rather than the implementation:
// the release function IS idempotent (a `spent` flag), waiters ARE granted FIFO, `runExclusive`
// serialises and releases on throw, and the state is #private so the encapsulation case cannot reach it.
//
// Expected, MEASURED in the pre-flight rather than assumed: the contract passes everything EXCEPT the
// HAND-OFF case, where an acquire barges ahead of a waiter that already holds the transfer.
export class AsyncMutex {
  #locked = false;
  #waiters: Array<() => void> = [];

  get isLocked(): boolean {
    return this.#locked;
  }

  get queueLength(): number {
    return this.#waiters.length;
  }

  acquire(): Promise<() => void> {
    if (!this.#locked) {
      this.#locked = true;
      return Promise.resolve(this.#makeRelease());
    }
    return new Promise<() => void>((resolve) => {
      this.#waiters.push(() => resolve(this.#makeRelease()));
    });
  }

  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  #makeRelease(): () => void {
    let spent = false;
    return () => {
      // Idempotent on purpose: the defect under test is the hand-off, not a spent release function.
      if (spent) return;
      spent = true;

      // THE DEFECT. The lock is marked free here, and the waiter is woken below WITHOUT being made the
      // owner. `isLocked` therefore reads false while a waiter holds the lock, and a fresh acquire in
      // the same turn finds it free and takes it.
      this.#locked = false;
      const next = this.#waiters.shift();
      if (next) next();
    };
  }
}
