'use strict'

// A reference implementation of experiments/delegation-ab/SPEC-2.md, written from the specification
// and not from the judge, plus the mutations that verify the judge can fail.
//
// This file exists to answer two questions about the judge and nothing else:
//
//   1. Is it satisfiable? A correct reading of the specification must take it green. If it cannot, the
//      judge is unfair and no arm could ever have passed it, which would make the experiment void.
//   2. Can it fail? Each mutation below is a mistake a plausible implementation actually makes -- and
//      the interesting ones are the mistakes that satisfy every count-based check while getting the
//      numbers wrong, which is the whole reason the judge is the thing being tested.
//
// The mutation is chosen by the WINDOW_MUTATION environment variable so that the reviewed reference is
// the only implementation in the tree. Unset, it is the correct one.
//
// NOT part of the experiment. The arms never see this file: it is a solution to the task, and a worker
// that could read it would be reading the answer.

const MUTATION = process.env.WINDOW_MUTATION || 'none'

function createAggregationWindow(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('options is required')
  const capacity = options.capacity
  const windowMs = options.windowMs
  const now = options.now
  if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity <= 0) {
    throw new TypeError('capacity must be a positive integer')
  }
  if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) {
    throw new TypeError('windowMs must be a positive finite number')
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function')

  const samples = []
  const counters = { accepted: 0, evicted: 0, expired: 0, queries: 0 }

  // Within the window when N < T + windowMs; so `windowMs` itself is expired, not retained.
  const isLive = (sample, at) =>
    MUTATION === 'boundary-inclusive' ? at <= sample.at + windowMs : at < sample.at + windowMs

  const removeExpired = (at) => {
    if (MUTATION === 'no-age-expiry') return
    while (samples.length > 0 && !isLive(samples[0], at)) {
      samples.shift()
      counters.expired += 1
    }
  }

  const enforceCapacity = () => {
    while (samples.length > capacity) {
      if (MUTATION === 'evict-newest') {
        samples.pop()
        counters.evicted += 1
        continue
      }
      samples.shift()
      // A capacity discard is not an age discard, whatever else is also true of the sample.
      if (MUTATION === 'capacity-as-expired') counters.expired += 1
      else counters.evicted += 1
    }
  }

  return {
    accept(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError('value must be a finite number')
      }
      const at = now()
      samples.push({ value, at })
      counters.accepted += 1
      removeExpired(at)
      enforceCapacity()
    },

    aggregate() {
      const at = now()
      removeExpired(at)
      counters.queries += 1
      const count = samples.length
      const out = { count, sum: 0, min: undefined, max: undefined, mean: undefined }
      for (const sample of samples) {
        out.sum += sample.value
        if (out.min === undefined || sample.value < out.min) out.min = sample.value
        if (out.max === undefined || sample.value > out.max) out.max = sample.value
      }
      if (MUTATION === 'min-max-zero' && count > 0) {
        out.min = Math.min(out.min, 0)
        out.max = Math.max(out.max, 0)
      }
      if (count > 0) out.mean = out.sum / count
      return out
    },

    values() {
      const at = now()
      removeExpired(at)
      counters.queries += 1
      return samples.map((sample) => sample.value)
    },

    retainedCount() {
      const at = now()
      if (MUTATION === 'count-removes') {
        // The violation this mutation exists to catch: reporting the right number while quietly
        // dropping what it looked at. Nothing about the count reveals it; only a later call does.
        removeExpired(at)
        return samples.length
      }
      let kept = 0
      for (const sample of samples) if (isLive(sample, at)) kept += 1
      return kept
    },

    clear() {
      samples.length = 0
    },

    stats() {
      return { ...counters }
    },
  }
}

module.exports = { createAggregationWindow }
