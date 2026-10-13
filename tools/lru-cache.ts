class Node<K, V> {
  key: K;
  value: V;
  prev: Node<K, V> | null = null;
  next: Node<K, V> | null = null;

  constructor(key: K, value: V) {
    this.key = key;
    this.value = value;
  }
}

export class LRUCache<K, V> {
  #capacity: number;
  #map: Map<K, Node<K, V>>;
  #head: Node<K, V>;
  #tail: Node<K, V>;
  #size: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('capacity must be a positive integer');
    }
    this.#capacity = capacity;
    this.#map = new Map();
    this.#head = new Node<K, V>(null as unknown as K, null as unknown as V);
    this.#tail = new Node<K, V>(null as unknown as K, null as unknown as V);
    this.#head.next = this.#tail;
    this.#tail.prev = this.#head;
    this.#size = 0;
  }

  get size(): number {
    return this.#size;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get(key: K): V | undefined {
    const node = this.#map.get(key);
    if (!node) return undefined;
    this.#removeNode(node);
    this.#addToHead(node);
    return node.value;
  }

  set(key: K, value: V): void {
    const existing = this.#map.get(key);
    if (existing) {
      existing.value = value;
      this.#removeNode(existing);
      this.#addToHead(existing);
      return;
    }
    const node = new Node<K, V>(key, value);
    this.#map.set(key, node);
    this.#addToHead(node);
    this.#size += 1;
    if (this.#size > this.#capacity) {
      const lru = this.#tail.prev;
      if (lru && lru !== this.#head) {
        this.#removeNode(lru);
        this.#map.delete(lru.key);
        this.#size -= 1;
      }
    }
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  delete(key: K): boolean {
    const node = this.#map.get(key);
    if (!node) return false;
    this.#removeNode(node);
    this.#map.delete(key);
    this.#size -= 1;
    return true;
  }

  clear(): void {
    this.#map.clear();
    this.#head.next = this.#tail;
    this.#tail.prev = this.#head;
    this.#size = 0;
  }

  #removeNode(node: Node<K, V>): void {
    const prev = node.prev;
    const next = node.next;
    if (prev) prev.next = next;
    if (next) next.prev = prev;
    node.prev = null;
    node.next = null;
  }

  #addToHead(node: Node<K, V>): void {
    const next = this.#head.next;
    this.#head.next = node;
    node.prev = this.#head;
    node.next = next;
    if (next) next.prev = node;
  }
}