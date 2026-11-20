/**
 * @fileoverview Async HTTP client with AbortController cancellation for stale
 * polling requests, concurrent GET deduplication, and Sidecar / Standalone transport.
 */

const inFlightGets = new Map();
const activeControllers = new Map();

export async function callSidecarApi(path, { method = 'GET', body, abortKey = '' } = {}) {
  const upperMethod = method.toUpperCase();
  const dedupKey = upperMethod === 'GET' && !abortKey ? path : '';

  if (dedupKey && inFlightGets.has(dedupKey)) {
    return inFlightGets.get(dedupKey);
  }

  let signal;
  let requestController = null;
  if (abortKey && typeof AbortController !== 'undefined') {
    const prev = activeControllers.get(abortKey);
    if (prev) {
      prev.abort();
    }
    requestController = new AbortController();
    activeControllers.set(abortKey, requestController);
    signal = requestController.signal;
  }

  const execHttpOnce = async () => {
    const sidecar = typeof window !== 'undefined' ? window.sidecar : null;
    const fetchFn = sidecar?.fetch
      ? sidecar.fetch.bind(sidecar)
      : typeof window !== 'undefined' && typeof window.fetch === 'function'
        ? window.fetch.bind(window)
        : globalThis.fetch.bind(globalThis);
    const headers = { 'Content-Type': 'application/json' };
    const res = await fetchFn(path, {
      method: upperMethod,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (signal?.aborted) {
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    const data = await res.json().catch(() => ({}));
    if (signal?.aborted) {
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  };

  const runRequest = async () => {
    try {
      return await execHttpOnce();
    } catch (fetchErr) {
      if (signal?.aborted || fetchErr?.name === 'AbortError') {
        throw fetchErr;
      }
      if (upperMethod === 'GET') {
        await new Promise((r) => setTimeout(r, 180));
        if (!signal?.aborted) {
          return execHttpOnce();
        }
      }
      throw fetchErr;
    }
  };

  const promise = runRequest().finally(() => {
    if (dedupKey) {
      inFlightGets.delete(dedupKey);
    }
    if (abortKey && requestController && activeControllers.get(abortKey) === requestController) {
      activeControllers.delete(abortKey);
    }
  });

  if (dedupKey) {
    inFlightGets.set(dedupKey, promise);
  }
  return promise;
}
