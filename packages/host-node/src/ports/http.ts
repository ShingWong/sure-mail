// http port: GET for http.fetch effects (autodiscover, M2). Bounded:
// redirect cap, response size cap, timeout. TLS verifies by default.

import http from "node:http";
import https from "node:https";

export interface HttpResult {
  status?: number;
  body?: string;
  url?: string;
  error?: string;
}

export interface HttpOptions {
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
  allowSelfSigned?: boolean;
}

export async function fetchText(url: string, options: HttpOptions = {}): Promise<HttpResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30000;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const result = await getOnce(current, maxBytes, timeoutMs, options.allowSelfSigned ?? false);
    const status = result.status ?? 0;
    if (status >= 300 && status < 400) {
      const location = result.headers?.["location"];
      const next = Array.isArray(location) ? location[0] : location;
      if (!next) return { error: `redirect without location (${status})`, url: current };
      current = new URL(next, current).toString();
      continue;
    }
    return { ...result, url: current };
  }
  return { error: `too many redirects (>${maxRedirects})`, url };
}

interface OnceResult extends HttpResult {
  headers?: http.IncomingHttpHeaders;
}

function getOnce(
  url: string,
  maxBytes: number,
  timeoutMs: number,
  allowSelfSigned: boolean,
): Promise<OnceResult> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ error: `invalid url: ${url}` });
      return;
    }
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.get(parsed, { rejectUnauthorized: !allowSelfSigned }, (res) => {
      const status = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          req.destroy();
          resolve({ error: `response exceeded ${maxBytes} bytes`, status });
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({ status, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers });
      });
      res.on("error", (err: Error) => {
        resolve({ error: err.message, status });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on("error", (err: Error) => {
      resolve({ error: err.message });
    });
  });
}
