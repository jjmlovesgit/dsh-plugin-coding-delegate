// NEGATIVE FIXTURE - never imported by the module under test, only by the discrimination gate.
//
// It is deliberately PLAUSIBLE and deliberately WRONG in exactly one respect: it keeps its heap in a
// public own property, so any caller can reach the live backing array. Everything else about it is
// correct, including the ordering it produces -- which is the point. A fixture that failed for many
// reasons would prove nothing about the case it is meant to exercise.
//
// Expected: the contract passes every case EXCEPT "prevents internal array corruption via direct
// mutation", which it must fail. Verified in this session: size 3 -> 1 and peek 1 -> 999 after a
// caller does `fixture.heap.length = 0; fixture.heap.push(999)`.
export class PriorityQueue<T> {
  heap: T[] = [];
  private cmp: (a: T, b: T) => number;

  constructor(comparator?: (a: T, b: T) => number) {
    this.cmp = comparator ?? ((a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0));
  }

  get size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  peek(): T | undefined {
    return this.heap[0];
  }

  push(item: T): void {
    this.heap.push(item);
    this.heap.sort(this.cmp);
  }

  pop(): T | undefined {
    return this.heap.shift();
  }
}
