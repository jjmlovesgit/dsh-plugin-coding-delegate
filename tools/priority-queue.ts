export class PriorityQueue<T> {
  #heap: T[] = [];
  #comparator: (a: T, b: T) => number;

  constructor(comparator?: (a: T, b: T) => number) {
    this.#comparator = comparator ?? ((a: T, b: T) => {
      const aNum = a as unknown as number;
      const bNum = b as unknown as number;
      return aNum - bNum;
    });
  }

  get size(): number {
    return this.#heap.length;
  }

  isEmpty(): boolean {
    return this.#heap.length === 0;
  }

  peek(): T | undefined {
    return this.#heap.length > 0 ? this.#heap[0] : undefined;
  }

  push(item: T): void {
    this.#heap.push(item);
    this.#siftUp(this.#heap.length - 1);
  }

  pop(): T | undefined {
    if (this.#heap.length === 0) {
      return undefined;
    }
    const top = this.#heap[0];
    const last = this.#heap.pop()!;
    if (this.#heap.length > 0) {
      this.#heap[0] = last;
      this.#siftDown(0);
    }
    return top;
  }

  #siftUp(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.#comparator(this.#heap[index], this.#heap[parent]) < 0) {
        this.#swap(index, parent);
        index = parent;
      } else {
        break;
      }
    }
  }

  #siftDown(index: number): void {
    const length = this.#heap.length;
    while (true) {
      let smallest = index;
      const left = 2 * index + 1;
      const right = 2 * index + 2;

      if (left < length && this.#comparator(this.#heap[left], this.#heap[smallest]) < 0) {
        smallest = left;
      }
      if (right < length && this.#comparator(this.#heap[right], this.#heap[smallest]) < 0) {
        smallest = right;
      }
      if (smallest !== index) {
        this.#swap(index, smallest);
        index = smallest;
      } else {
        break;
      }
    }
  }

  #swap(i: number, j: number): void {
    const temp = this.#heap[i];
    this.#heap[i] = this.#heap[j];
    this.#heap[j] = temp;
  }
}