import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeTransportError,
  fetchWithTransportRetry,
  isRetryableTransportError,
  TRANSPORT_MAX_ATTEMPTS,
} from '../src/delegation';

/**
 * Transport retry is the plugin's only retry, and its value is entirely in WHICH failures it repeats.
 * These cases pin that boundary: a 5xx or a refused connection is retried on the attested schedule, a
 * 4xx or an abort is not, and the retry count surfaces in the verdict so a slow delegation is
 * explainable after the fact.
 *
 * `sleep` is injected rather than real: the schedule is asserted on the CALLS, so the suite runs in
 * microseconds while still proving the delays are 500 ms then 1000 ms from attempt 0.
 */

const jsonResponse = (status: number) => new Response('{"choices":[]}', { status });
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const fakeSleep = () => vi.fn(async (_ms: number) => undefined);

const run = (fetchMock: unknown, options: Record<string, unknown> = {}) => {
  vi.stubGlobal('fetch', fetchMock);
  const sleep = fakeSleep();
  return { sleep, promise: fetchWithTransportRetry('http://127.0.0.1:1234/v1/chat/completions', { method: 'POST' }, { sleep, ...options }) };
};

describe('fetchWithTransportRetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the first successful response without sleeping', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    const { promise, sleep } = run(fetchMock);
    const attempt = await promise;

    expect(attempt.response?.status).toBe(200);
    expect(attempt.retries).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a 503 on the attested schedule and reports the retry count', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503))
      .mockResolvedValueOnce(jsonResponse(503))
      .mockResolvedValueOnce(jsonResponse(200));
    const { promise, sleep } = run(fetchMock);
    const attempt = await promise;

    expect(attempt.response?.status).toBe(200);
    expect(attempt.retries).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([500, 1000]);
  });

  it('retries every status classified as transient', async () => {
    for (const status of [500, 502, 503, 504]) {
      const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(status)).mockResolvedValueOnce(jsonResponse(200));
      const { promise } = run(fetchMock);
      const attempt = await promise;
      expect(attempt.response?.status).toBe(200);
      expect(attempt.retries).toBe(1);
      vi.unstubAllGlobals();
    }
  });

  it('does not retry a 4xx: the request itself is wrong', async () => {
    for (const status of [400, 401, 404, 422]) {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status));
      const { promise, sleep } = run(fetchMock);
      const attempt = await promise;

      expect(attempt.response?.status).toBe(status);
      expect(attempt.retries).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it('retries a refused connection and reports the final error when attempts run out', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.reject(refused()));
    const { promise, sleep } = run(fetchMock);
    const attempt = await promise;

    expect(attempt.response).toBeNull();
    expect(attempt.retries).toBe(TRANSPORT_MAX_ATTEMPTS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(TRANSPORT_MAX_ATTEMPTS);
    expect(describeTransportError(attempt.error)).toBe('ECONNREFUSED');
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([500, 1000]);
  });

  it('returns the last response when the final attempt is still a 5xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500));
    const { promise } = run(fetchMock);
    const attempt = await promise;

    expect(attempt.response?.status).toBe(500);
    expect(attempt.retries).toBe(TRANSPORT_MAX_ATTEMPTS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(TRANSPORT_MAX_ATTEMPTS);
  });

  it('does not retry an abort: the caller deadline expired', async () => {
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const fetchMock = vi.fn().mockRejectedValue(abort);
    const { promise, sleep } = run(fetchMock);
    const attempt = await promise;

    expect(attempt.response).toBeNull();
    expect(attempt.retries).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry an error with no transport code', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const { promise } = run(fetchMock);
    const attempt = await promise;

    expect(attempt.response).toBeNull();
    expect(attempt.retries).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honours a smaller attempt budget without changing the schedule', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.reject(refused()));
    const { promise, sleep } = run(fetchMock, { maxAttempts: 2 });
    const attempt = await promise;

    expect(attempt.retries).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([500]);
  });
});

describe('isRetryableTransportError', () => {
  it('classifies transport codes and nothing else', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']) {
      expect(isRetryableTransportError(Object.assign(new Error('x'), { cause: { code } }))).toBe(true);
    }
    expect(isRetryableTransportError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe(false);
    expect(isRetryableTransportError(new TypeError('fetch failed'))).toBe(false);
    expect(isRetryableTransportError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false);
    expect(isRetryableTransportError(null)).toBe(false);
  });
});
