# Specification: a bounded sliding aggregation window

Architect-authored specification, in the form of [`../contract-first/SPEC.md`](../contract-first/SPEC.md):
prose and interface only, no algorithm, no data structure, no implementation strategy. Every clause below
is a statement about observable behaviour. Written before any implementation and before any test, and
frozen with [`tests/spec-conformance-2.test.cjs`](tests/spec-conformance-2.test.cjs) before either arm of
[`PROTOCOL.md`](PROTOCOL.md) runs.

## Why this module

The TTL cache task meets its hard parts in the places where a store, a recency order, an expiry rule and
four counters interact. This task has the same shape at a different angle: a sample sequence, a trailing
time window, a **capacity** bound, and four counters that meet. Three of its clauses are where a plausible
implementation is subtly wrong, and each is pinned by the judge:

- **Age is measured against the current clock reading, not against the newest sample.** A sliding window
  is not a gap-based or session-based one.
- **Aggregates are computed over what actually remains after discards, in acceptance order, so a capacity
  discard silently changes the total.** A version that tracks a running total and forgets to subtract a
  discarded sample satisfies every count-based check and is still wrong.
- **An observation must have no side effects.** `retainedCount()` may *see* that samples are outside the
  window and must not remove them, so it is the rule a plausible implementation most often violates.

## Interface

The workspace exports a single factory from `src/aggregation-window.js`:

    createAggregationWindow(options) -> window

`options` has exactly three required properties:

| option | requirement |
| --- | --- |
| `capacity` | a positive integer |
| `windowMs` | a positive finite number |
| `now` | a function of no arguments returning a number, in milliseconds |

Each is validated at construction, and each is required. There are no defaults and no optional aliases.
A value that fails its requirement throws a `TypeError`, and a missing `options` object throws a
`TypeError` as well. Nothing is validated at call time beyond the one call-time rule stated under
`accept` — an invalid *option* is a programming error and must surface immediately rather than be
tolerated.

The clock is **injected** and is the only source of time: the module must never call `Date.now()` and must
never read any other ambient time source. The clock is assumed never to go backwards. Where a clause below
says "at the current moment", it means: a method that needs the current instant reads `now()` and that one
reading is the current moment for the whole of that method. How many times `now()` is called during a
method is not observable through this interface and is not specified.

## The window

### What is retained

The module holds a finite sequence of samples, each carrying a numeric value and the moment it was
accepted. The sequence is in **acceptance order**: oldest first, newest last.

A sample whose acceptance moment is `T` is **within the window** at current moment `N` when
`N < T + windowMs`, and is **expired** otherwise. Equivalently, a sample is expired when its age reaches
the window — `windowMs` itself is expired, not retained. This one rule defines both what queries answer
over and what is eventually discarded for age. `windowMs` is a trailing window measured from the current
moment, not a gap between consecutive samples and not a bound on how many samples may share a moment.

### `accept(value)`

- Appends the sample to the retained sequence at the end, at the current moment.
- `value` must be a finite number — `NaN`, `Infinity` and `-Infinity` are not. A value that fails throws a
  `TypeError`, **records nothing and changes no counter**. This is the only call-time validation in the
  specification.
- Then reconciles the retained sequence, in this order, and this order is normative:
  1. Remove every retained sample that is expired at the current moment, oldest first.
  2. Then, while the number of retained samples exceeds `capacity`, remove the **oldest** remaining sample,
     once per excess sample.
- A sample removed by step 1 increments `expired` and never increments `evicted`. A sample removed by step
  2 increments `evicted` and never increments `expired`. The two reasons are mutually exclusive and each
  counter counts a *reason for leaving*, not the method that happened to notice. In particular a sample too
  old to be allowed to remain is never counted as a capacity discard, whichever bound it also exceeds.

### `aggregate()`

Answers over the samples retained at the current moment, at the current moment.

- Removes every sample expired at the current moment, exactly as `accept` step 1 does, incrementing
  `expired` by one per sample removed.
- Returns a **fresh** object with exactly these five properties:

| property | value |
| --- | --- |
| `count` | how many samples are retained |
| `sum` | the total of their values |
| `min` | the smallest of their values |
| `max` | the largest of their values |
| `mean` | `sum / count` |

- Order matters to the answer only in that the answer is over the retained samples and no others: a value
  that has been discarded, for either reason, must not contribute to any of the five.
- When no samples are retained, `count` is `0` and `sum` is `0`; `min`, `max` and `mean` are `undefined`.
- Mutating the returned object must not affect the module.

### `values()`

- Removes every sample expired at the current moment, exactly as `aggregate` does, incrementing `expired`
  by one per sample removed.
- Returns a **fresh array** of the values retained at the current moment, in acceptance order, oldest
  first.
- The array is a copy: mutating it must not affect the module.

### `retainedCount()`

Answers how many samples would be retained at the current moment, were the window reconciled now. It is an
**observation and must have no side effects**: it must not remove any sample, whether expired or not, and
must not increment any counter. It returns a non-negative integer.

This clause is load-bearing and is stated once more, plainly: `retainedCount()` reads the clock and reports
a count. Nothing else about the module may change because it was called.

### `clear()`

Removes every retained sample, whether expired or not, and returns nothing. It increments **no** counter:
neither `expired` nor `evicted` nor `queries`. Counters describe the window's whole life, not its current
contents.

### `stats()`

Returns a **fresh** object with exactly these four counters, all starting at zero:

| counter | incremented when |
| --- | --- |
| `accepted` | an `accept` recorded a sample |
| `evicted` | a sample was removed to satisfy `capacity` |
| `expired` | a sample was removed because it was outside the window |
| `queries` | an `aggregate` or `values` call was answered |

Rules the table does not carry:

- Every counter is cumulative for the life of the object, including across `clear()`.
- `stats()` is itself **not** a query and does not increment `queries`.
- `retainedCount()` is **not** a query and does not increment `queries`.
- An `accept` call that throws validates before it records, so it increments neither `accepted` nor any
  other counter and discards nothing.
- The returned object is a copy: mutating it must not affect the module.

## Reasons a sample leaves, stated once

A sample leaves the retained sequence for exactly three reasons and each has its own accounting. It is
removed for **age** by `accept`, `aggregate`, or `values`, and increments `expired`. It is removed for
**capacity** by `accept`, and increments `evicted`. It is removed unconditionally by `clear()`, and
increments nothing. No sample increments two of these for one removal, and no removal by `clear()` is ever
attributed to age or to capacity. This is the single most load-bearing accounting rule in the
specification.

## Out of scope

Not required, and not to be added: iteration over samples other than through `values()`, serialisation,
events or callbacks, per-sample weighting, quantiles, medians, or any statistic beyond the five named in
`aggregate()`, a resettable or per-window counter view, window extension or shortening after construction,
multiple windows on one object, and any background timer or scheduling. No requirement is placed on the
retention structure, on memory, or on the asymptotic cost of any method.
