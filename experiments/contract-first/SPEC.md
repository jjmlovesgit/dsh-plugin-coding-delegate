# Specification: a bounded TTL cache with LRU eviction

Architect-authored specification for the experiment in [`docs/experiment.md`](../../docs/experiment.md).
Written **before** any implementation, and before any test. This file is the architect's whole
contribution to the unit: everything below is a behavioural requirement, and no algorithm is given.

## Why this module

Item 15 asks whether the loop can carry a unit with *internal structure* rather than a leaf. The debrand
oracle was a small function under test. This has four parts that interact — a store, a recency order, an
expiry rule and a set of counters — where the hard part is not any one of them but the places they meet.
Those meeting points are where a plausible implementation is subtly wrong, which is what makes it a fair
test of whether a contract can catch that.

## Interface

The workspace exports a single factory from `src/ttl-cache.js`:

    createTtlCache(options) -> cache

`options` has exactly three required properties:

| option | requirement |
| --- | --- |
| `maxEntries` | a positive integer |
| `ttlMs` | a positive finite number |
| `now` | a function of no arguments returning a number, in milliseconds |

Each is validated at construction. A value that fails its requirement throws a `TypeError`. Nothing is
validated at call time — an invalid option is a programming error and must surface immediately rather
than be tolerated.

The clock is **injected** and is the only source of time. The module must never call `Date.now()`.

## The cache

### Expiry

Setting a key records an expiry of `now() + ttlMs` **at the moment of that set**. An entry is *expired*
when `now() >= expiry`. Expiry is therefore a function of the clock, not of a timer, and nothing expires
unless something asks.

### `set(key, value)`

- Inserts the key, or replaces its value if it is already present.
- Sets the entry's expiry as above, in both the insert and the replace case.
- Makes the key **most recently used**, in both cases.
- Replacing an existing key is **not** an eviction and must not increment `evictions`.
- After the set, if the number of **live** entries exceeds `maxEntries`, entries are evicted
  least-recently-used first, repeatedly, until the count is at or below `maxEntries`. Each entry removed
  this way increments `evictions` by one.
- Eviction chooses strictly by recency. It does not prefer expired entries, and it must not remove the
  key just set unless that key is the only one that could satisfy the bound.

### `get(key)`

- If the key is absent: increment `misses`, return `undefined`.
- If the key is present but expired: remove the entry, increment `expirations`, increment `misses`,
  return `undefined`.
- If the key is present and live: increment `hits`, make the key most recently used, return its value.

### `has(key)`

Answers whether `get(key)` would return a value. It is an **observation and must have no effect**: it
must not change recency, must not increment any counter, and must not remove an expired entry. It returns
a boolean.

### `delete(key)`

Removes the entry if present, whether live or expired. Returns `true` if an entry was removed and `false`
otherwise. A removal this way increments **neither** `evictions` nor `expirations`.

### `clear()`

Removes every entry. The counters are **not** reset — they describe the cache's whole life, not its
current contents.

### `purge()`

Removes every expired entry, increments `expirations` by the number removed, and returns that number.
Recency of the surviving entries is unchanged.

### `size`

A property, not a function. It is the number of **live** entries at `now()`. Reading it has **no side
effects**: it does not remove expired entries and does not change any counter.

### `stats()`

Returns a fresh object with exactly four counters, all starting at zero:

| counter | incremented when |
| --- | --- |
| `hits` | a `get` returned a value |
| `misses` | a `get` returned `undefined`, for either reason |
| `evictions` | an entry was removed to satisfy `maxEntries` |
| `expirations` | an entry was found expired and removed, by `get` or by `purge` |

The returned object is a copy: mutating it must not affect the cache.

## Recency, stated once

Recency is updated by a successful `get` and by any `set`. It is **not** updated by `has`, `delete`,
`purge`, `size` or `stats`. This is the single most load-bearing rule in the specification and the one a
plausible implementation is most likely to violate.

## Out of scope

Not required, and not to be added: iteration, serialisation, events, per-key TTL overrides, a maximum
value size, or any background timer.
