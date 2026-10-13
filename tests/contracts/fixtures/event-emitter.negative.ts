// NEGATIVE FIXTURE - never imported by the module under test, only by the discrimination gate.
//
// It is deliberately PLAUSIBLE and it is the classic implementation: a Map of listener arrays, and an
// emit that indexes the LIVE array. Everything else is right -- chaining, duplicate registrations,
// argument forwarding, `once` unregistering before it invokes, listenerCount, removeAllListeners, and a
// #private store the encapsulation case cannot reach.
//
// It is wrong in exactly one respect: it does not take a SNAPSHOT before dispatching. That single
// defect has three observable consequences, and all three are cases in the contract:
//
//   - a listener removing ANOTHER listener mid-dispatch shifts the array and skips the next one;
//   - a listener removing ITSELF does the same;
//   - a listener ADDED mid-dispatch runs inside the dispatch that added it, because the loop bound is
//     read from the same array it is growing.
//
// Expected, MEASURED in the pre-flight rather than assumed: the contract passes everything EXCEPT the
// three SNAPSHOT cases.
export class EventEmitter<
  Events extends Record<string, (...args: any[]) => void> = Record<string, (...args: any[]) => void>
> {
  #events = new Map<string, Array<(...args: any[]) => void>>();

  on<E extends keyof Events & string>(event: E, listener: Events[E]): this {
    const existing = this.#events.get(event);
    if (existing) existing.push(listener as (...args: any[]) => void);
    else this.#events.set(event, [listener as (...args: any[]) => void]);
    return this;
  }

  once<E extends keyof Events & string>(event: E, listener: Events[E]): this {
    const wrapper = (...args: any[]) => {
      // Correct, and deliberately so: this fixture's ONE defect is the missing snapshot. Unregistering
      // before invoking is what keeps the re-entrancy case passing here.
      this.off(event, wrapper as Events[E]);
      (listener as (...args: any[]) => void)(...args);
    };
    return this.on(event, wrapper as Events[E]);
  }

  off<E extends keyof Events & string>(event: E, listener: Events[E]): this {
    const list = this.#events.get(event);
    if (!list) return this;
    const at = list.indexOf(listener as (...args: any[]) => void);
    if (at !== -1) list.splice(at, 1);
    return this;
  }

  emit<E extends keyof Events & string>(event: E, ...args: Parameters<Events[E]>): boolean {
    const list = this.#events.get(event);
    if (!list || list.length === 0) return false;
    // THE DEFECT. `list` is the live array and `list.length` is re-read every iteration, so a callback
    // that removes a listener makes this loop skip the entry that shifts into the current index, and a
    // callback that adds one is invoked inside the dispatch that added it.
    for (let i = 0; i < list.length; i += 1) {
      list[i](...args);
    }
    return true;
  }

  listenerCount(event: keyof Events & string): number {
    const list = this.#events.get(event);
    return list ? list.length : 0;
  }

  removeAllListeners(event?: keyof Events & string): this {
    if (event === undefined) this.#events.clear();
    else this.#events.delete(event);
    return this;
  }
}
