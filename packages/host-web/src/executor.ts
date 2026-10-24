// Effect executor (browser): dispatches drained effects to the relay net
// port, the store worker client, and the http/dns ports, feeding results
// back into the core. Unknown effects are logged; when they carry an `id`
// the host rejects them with an error feed on `<kind>.result`. Same
// contract as the Node host's executor.

import { fromBase64 } from "./base64.ts";
import { lookupRecord } from "./ports/dns.ts";
import { fetchText } from "./ports/http.ts";
import type { RelayNetPorts } from "./ports/net.ts";
import type { StoreExecutor } from "./store/client.ts";

export interface Effect {
  kind: string;
  id?: number;
  transport?: string;
  host?: string;
  port?: number;
  tls?: boolean;
  b64?: string;
  level?: string;
  msg?: string;
  store?: string;
  sql?: string;
  params?: unknown[];
  url?: string;
  lookup?: string;
  name?: string;
}

export type FeedFn = (kind: string, data: Record<string, unknown>) => void;

export interface ExecutorContext {
  feed: FeedFn;
  log: (level: string, msg: string) => void;
  net: RelayNetPorts;
  store: StoreExecutor;
  http?: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch };
}

function detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function executeEffect(eff: Effect, ctx: ExecutorContext): Promise<void> {
  switch (eff.kind) {
    case "log": {
      ctx.log(eff.level ?? "info", eff.msg ?? "");
      return;
    }
    case "net.open": {
      if (!eff.transport || !eff.host || eff.port === undefined) {
        if (eff.transport) ctx.feed("net.error", { transport: eff.transport, error: "malformed net.open" });
        return;
      }
      ctx.net.open(eff.transport, eff.host, eff.port, eff.tls ?? false);
      return;
    }
    case "net.upgrade": {
      if (eff.transport) ctx.net.upgrade(eff.transport);
      return;
    }
    case "net.write": {
      if (!eff.transport) return;
      const bytes = eff.b64 !== undefined ? fromBase64(eff.b64) : new Uint8Array(0);
      ctx.net.write(eff.transport, bytes);
      return;
    }
    case "net.close": {
      if (eff.transport) ctx.net.close(eff.transport);
      return;
    }
    case "store.exec": {
      const id = eff.id;
      if (id === undefined) return;
      try {
        const result = await ctx.store.exec(eff.store ?? "registry", eff.sql ?? "", eff.params ?? []);
        ctx.feed("store.result", { id, rows: result.rows, changes: result.changes, insertId: result.insertId });
      } catch (err) {
        ctx.feed("store.result", {
          id,
          error: { code: -5, where: "store.exec", detail: detail(err) },
        });
      }
      return;
    }
    case "dns.lookup": {
      const id = eff.id;
      if (id === undefined || !eff.name) return;
      const result = await lookupRecord(ctx.net, id, eff.lookup ?? "a", eff.name);
      ctx.feed("dns.result", { id, ...result });
      return;
    }
    case "http.fetch": {
      const id = eff.id;
      if (id === undefined || !eff.url) return;
      const result = await fetchText(eff.url, id, { ...ctx.http, net: ctx.net });
      ctx.feed("http.result", {
        id,
        status: result.status,
        body: result.body,
        error: result.error,
      });
      return;
    }
    default: {
      ctx.log("warn", `unsupported effect: ${eff.kind}`);
      if (eff.id !== undefined) {
        ctx.feed(`${eff.kind}.result`, {
          id: eff.id,
          error: { code: -6, where: "effect", detail: `unsupported effect kind: ${eff.kind}` },
        });
      }
      return;
    }
  }
}
