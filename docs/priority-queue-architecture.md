# PriorityQueue — architecture record

## Provenance, read this first

This document was written **after** `tools/priority-queue.ts` was generated, and it is a description of
what was built and of what the contract already enforces. It is **not** the specification the contract
was derived from.

The order was: requirements were stated in a brief → the contract was authored → the contract was
proven to discriminate against a deliberately corruptible fixture → the contract was handed to the
local worker → the module was generated → this document was written. Anyone reading this as the source
of truth for the contract has the order backwards, and the distinction matters because a
retrospectively-authored architecture doc can make a generated module look as though it were built to
a specification that existed beforehand.

## The invariant

`PriorityQueue<T>` is a **binary min-heap** by default: a complete binary tree stored in an array where
every parent orders before or equal to both of its children. The array is the tree — index `i` has

| relation | index |
| --- | --- |
| parent | `(i - 1) >> 1` |
| left child | `2 * i + 1` |
| right child | `2 * i + 2` |

Only the root is fully ordered against the whole set. The heap guarantees `heap[0]` is the minimum; it
does **not** keep the array sorted, and code must not assume it is.

`push` appends and sifts **up**; `pop` moves the last element to the root and sifts **down**. Both
restore the invariant along a single root-to-leaf path, which is what makes them logarithmic rather
than the `O(n log n)` a sorted-array implementation would cost per operation. The implementation does
not call `Array.prototype.sort` anywhere, and a regression that swapped the sift routines for a sort
would still satisfy every ordering assertion in the contract — only the complexity changes. That is a
real limit of behavioural testing, stated here because it is not something the suite can catch.

## API

| member | signature |
| --- | --- |
| `constructor` | `(comparator?: (a: T, b: T) => number)` |
| `push` | `(item: T): void` |
| `pop` | `(): T \| undefined` |
| `peek` | `(): T \| undefined` |
| `isEmpty` | `(): boolean` |
| `size` | `get size(): number` — a **getter**, not a method |

`pop()` and `peek()` on an empty queue return `undefined`. They do not throw, and `pop()` on an empty
queue is not an error to be caught — it is the documented boundary.

## The comparator, and its measured limit

The comparator is the standard three-way form: negative if `a` orders before `b`, positive if after,
zero if equal to the heap's purposes.

**With no comparator, ordering is numeric and only numeric.** The default is `a - b` on the values as
given. This is not a general "natural ordering", and the difference is worth stating precisely because
it fails quietly:

| input | default comparator | note |
| --- | --- | --- |
| `[50, 10, 30, 5]` | `[5, 10, 30, 50]` | correct |
| `["10", "9", "100"]` | `["9", "10", "100"]` | correct, by numeric coercion in `-` |
| `["b", "a", "c"]` | `["b", "c", "a"]` | **unordered** — `NaN` comparisons are never `< 0`, so nothing sifts |
| `["a", 1]` | `["a", 1]` | meaningless; mixed types are not a supported input |

For any `T` that is not a number — or a string that reads as one — an explicit comparator is
**required**. Omitting it does not throw and does not degrade gracefully: it returns elements in heap
order, which looks like a working queue returning wrong answers. A type-level guard is not possible
here without constraining `T`, so the requirement is documented rather than enforced.

A comparator passed explicitly is used for every comparison, and one that is not antisymmetric or not
transitive will produce an arbitrary order — the heap assumes a total order and does not validate it.

## Encapsulation

The backing store is a `#private` field, and that is a load-bearing design decision rather than a
style preference.

Anything reachable from the instance is reachable by a caller, and a caller who can reach the live
array can destroy the queue in one line: `pq.heap.length = 0`. Measured on a fixture that exposed the
heap publicly, mutating it took `size` from 3 to 1 and `peek()` from 1 to 999 — silently, with no
error, in a queue that still looked constructed.

`#private` fields are not own properties at all, so `Object.getOwnPropertyNames(pq)` returns `[]` and
there is no array to reach. This is asserted by the contract's corruption case, which walks every own
property and every prototype accessor, empties any array it finds, and then requires the queue to
still behave. That case asserts **behaviour** rather than the absence of an array property, so a getter
returning a defensive copy is not failed — only a leaked live store is.

## Complexity

| operation | time | space |
| --- | --- | --- |
| `push` | `O(log n)` | `O(1)` amortised |
| `pop` | `O(log n)` | `O(1)` |
| `peek` | `O(1)` | `O(1)` |
| `size` / `isEmpty` | `O(1)` | `O(1)` |
| whole queue | — | `O(n)` |

`n` is the number of stored items. No operation allocates a copy of the store; the array is grown by
`push` and reused.

## Dependencies and surface

No imports. No external runtime dependencies. No console output. Exactly one export,
`PriorityQueue`. It requires nothing of the host and can be loaded by Node's type stripping directly,
which is how the contract reaches it.

## How it is verified

`tests/contracts/priority-queue.contract.cjs` — six cases, run with `node` directly:

1. the exported generic class signature, read from source;
2. min-heap default over numbers, end to end;
3. a custom comparator over objects, as a max-heap;
4. the empty boundary — `peek`, `pop`, `size`, `isEmpty`;
5. randomized **interleaved** push/pop against a sorted shadow array, with `size` checked after every
   operation and the remainder drained at the end;
6. the corruption case described under Encapsulation.

Two of those cases were rewritten before the module was generated, and both for the same reason: the
first drafts named a guarantee they did not exercise. Case 6 called `peek()` and asserted `size`
without mutating anything, and passed on the corruptible fixture above. Case 5 pushed 150 values and
then drained the queue, so despite "interleaved" in its name it never pushed against a populated heap
and popped against it.

The discrimination check is the part worth repeating for the next unit: a fixture that violates the
property is run against the contract **before** the worker is dispatched. A contract that cannot fail
the fixture is not evidence, and a case whose name promises more than its body does is the shape that
produced a false green on `canonicalMerge`, where a decoupling case compared the wrong array and
passed on an implementation that aliased both of its inputs.
