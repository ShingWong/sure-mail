// http port (browser): GET for http.fetch effects (autodiscover, M2).
// Tries the browser's fetch first (CORS-open endpoints); on failure falls
// back to the relay proxy. Bounded: size cap + timeout. Never throws —
// failures come back as {error} for the ABI feed.

import type { RelayNetPorts } from "./net.ts";

export interface HttpResult {
  status?: number;
  body?: string;
  url?: string;
  error?: string;
}

export interface HttpOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Underlying fetch (browser global, or a stub in tests). */
  fetchImpl?: typeof fetch;
  /** Relay net port for the CORS fallback. */
  net?: RelayNetPorts;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;

export async function fetchText(url: string, id: number, options: HttpOptions = {}): Promise<HttpResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let directError: string | undefined;
  if (fetchImpl) {
    try {
      const result = await directFetch(url, fetchImpl, maxBytes, timeoutMs);
      if (result.error === undefined || result.status !== undefined) return result;
      directError = result.error;
    } catch (err) {
      directError = err instanceof Error ? err.message : String(err);
    }
  } else {
    directError = "no fetch implementation";
  }
  // CORS-blocked or unreachable — ask the relay.
  const net = options.net;
  if (net && net.proxyHttp) {
    const feed = await net.fetchViaRelay(id, url);
    const result: HttpResult = {
      status: typeof feed["status"] === "number" ? (feed["status"] as number) : undefined,
      body: typeof feed["body"] === "string" ? (feed["body"] as string) : undefined,
      url,
      error: feed["error"] === undefined ? undefined : String(feed["error"]),
    };
    if (result.error === undefined || result.status !== undefined) return result;
  }
  return { error: directError, url };
}

async function directFetch(url: string, fetchImpl: typeof fetch, maxBytes: number, timeoutMs: number): Promise<HttpResult> {
  const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    return { status: res.status, error: `response exceeded ${maxBytes} bytes`, url };
  }
  const text = await res.text();
  if (text.length > maxBytes) {
    return { status: res.status, error: `response exceeded ${maxBytes} bytes`, url };
  }
  return { status: res.status, body: text, url };
}
