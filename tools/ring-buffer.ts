export class RingBuffer<T> {
  #buffer: (T | undefined)[];
  #head: number;
  #size: number;
  #capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('capacity must be a positive integer');
    }
    this.#capacity = capacity;
    this.#buffer = new Array<T | undefined>(capacity);
    this.#head = 0;
    this.#size = 0;
  }

  get size(): number {
    return this.#size;
  }

  get capacity(): number {
    return this.#capacity;
  }

  isEmpty(): boolean {
    return this.#size === 0;
  }

  isFull(): boolean {
    return this.#size === this.#capacity;
  }

  push(item: T): boolean {
    if (this.#size === this.#capacity) {
      return false;
    }
    const tail = (this.#head + this.#size) % this.#capacity;
    this.#buffer[tail] = item;
    this.#size += 1;
    return true;
  }

  pop(): T | undefined {
    if (this.#size === 0) {
      return undefined;
    }
    const value = this.#buffer[this.#head] as T;
    this.#buffer[this.#head] = undefined;
    this.#head = (this.#head + 1) % this.#capacity;
    this.#size -= 1;
    return value;
  }

  peek(): T | undefined {
    if (this.#size === 0) {
      return undefined;
    }
    return this.#buffer[this.#head] as T;
  }
}
