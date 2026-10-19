/**
 * A plausible wrong answer, for the discrimination gate only. Never required by anything.
 *
 * It is correct in every respect except one: it counts requests in a TUMBLING window that restarts
 * when the current time crosses `windowStart + windowMs`, instead of logging each timestamp and
 * letting it age out on its own schedule. Capacity arithmetic, key isolation and reset all behave,
 * so the contract's other cases pass; what it cannot do is give back exactly the slots whose
 * timestamps have aged out -- at a boundary it hands the caller a fresh full allowance, which is the
 * burst a sliding window exists to prevent.
 */
export class SlidingWindowLog {
  private windowMs: number;
  private maxRequests: number;
  private logs: Map<string, { count: number; windowStart: number }>;

  constructor(windowMs: number, maxRequests: number) {
    if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('windowMs must be a positive finite number');
    }
    if (typeof maxRequests !== 'number' || !Number.isInteger(maxRequests) || maxRequests <= 0) {
      throw new RangeError('maxRequests must be a positive integer');
    }
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.logs = new Map();
  }

  allow(key: string, now: number): boolean {
    const entry = this.logs.get(key) || { count: 0, windowStart: now };

    // The defect: the whole window resets at once, so every call after a boundary starts clean
    // rather than losing only the timestamps that have actually aged out.
    if (now - entry.windowStart >= this.windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }

    if (entry.count >= this.maxRequests) {
      this.logs.set(key, entry);
      return false;
    }

    entry.count += 1;
    this.logs.set(key, entry);
    return true;
  }

  getRemaining(key: string, now: number): number {
    const entry = this.logs.get(key);
    if (!entry) return this.maxRequests;
    if (now - entry.windowStart >= this.windowMs) return this.maxRequests;
    return Math.max(0, this.maxRequests - entry.count);
  }

  reset(key?: string): void {
    if (key) {
      this.logs.delete(key);
    } else {
      this.logs.clear();
    }
  }
}
