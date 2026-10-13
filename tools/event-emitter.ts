export class EventEmitter<Events extends Record<string, (...args: any[]) => void>> {
  #listeners: Map<string, Array<(...args: any[]) => void>> = new Map();

  on<K extends keyof Events>(event: K, listener: Events[K]): this {
    const list = this.#listeners.get(event as string) ?? [];
    list.push(listener as (...args: any[]) => void);
    this.#listeners.set(event as string, list);
    return this;
  }

  once<K extends keyof Events>(event: K, listener: Events[K]): this {
    const wrapper = (...args: any[]): void => {
      this.off(event, wrapper);
      (listener as (...args: any[]) => void)(...args);
    };
    this.on(event, wrapper as Events[K]);
    return this;
  }

  off<K extends keyof Events>(event: K, listener: Events[K]): this {
    const list = this.#listeners.get(event as string);
    if (list) {
      const idx = list.indexOf(listener as (...args: any[]) => void);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
    }
    return this;
  }

  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): boolean {
    const list = this.#listeners.get(event as string);
    if (!list || list.length === 0) {
      return false;
    }
    const snapshot = [...list];
    for (const listener of snapshot) {
      listener(...(args as any[]));
    }
    return true;
  }

  listenerCount<K extends keyof Events>(event: K): number {
    const list = this.#listeners.get(event as string);
    return list ? list.length : 0;
  }

  removeAllListeners<K extends keyof Events>(event?: K): this {
    if (event !== undefined) {
      this.#listeners.delete(event as string);
    } else {
      this.#listeners.clear();
    }
    return this;
  }
}