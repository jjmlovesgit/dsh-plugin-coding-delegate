export class AsyncMutex {
  #locked = false;
  #queue: Array<() => void> = [];
  #released = new Set<() => void>();

  get isLocked(): boolean {
    return this.#locked;
  }

  get queueLength(): number {
    return this.#queue.length;
  }

  acquire(): Promise<() => void> {
    if (!this.#locked) {
      this.#locked = true;
      return Promise.resolve(this.#makeRelease());
    }
    return new Promise<() => void>((resolve) => {
      this.#queue.push(resolve);
    });
  }

  runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.acquire().then(async (release) => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  #makeRelease(): () => void {
    const release = (): void => {
      if (this.#released.has(release)) {
        return;
      }
      this.#released.add(release);
      if (this.#queue.length > 0) {
        const next = this.#queue.shift()!;
        next(this.#makeRelease());
      } else {
        this.#locked = false;
      }
    };
    return release;
  }
}
