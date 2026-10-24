// dns port (browser): the browser has no DNS API, so dns.lookup effects
// are proxied through the relay (docs/relay.md). Unresolvable request
// types feed back {unsupported: true} per the ABI.

import type { RelayNetPorts } from "./net.ts";

export interface DnsResult {
  records?: unknown[];
  unsupported?: boolean;
  error?: string;
}

/** Resolve via the relay proxy. Never throws; the feed shape is ABI-fixed. */
export async function lookupRecord(net: RelayNetPorts, id: number, type: string, name: string): Promise<DnsResult> {
  const feed = await net.lookup(id, name, type);
  const out: DnsResult = {};
  if (Array.isArray(feed["records"])) out.records = feed["records"];
  if (feed["unsupported"] === true) out.unsupported = true;
  if (feed["error"] !== undefined) out.error = String(feed["error"]);
  return out;
}
