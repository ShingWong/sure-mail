// dns port: node:dns resolution for dns.lookup effects (autodiscover, M2).
// Unresolvable request types feed back {unsupported: true} per the ABI.

import { Resolver } from "node:dns/promises";

export interface DnsResult {
  records?: unknown[];
  unsupported?: boolean;
  error?: string;
}

export async function lookupRecord(type: string, name: string): Promise<DnsResult> {
  const resolver = new Resolver();
  try {
    if (type === "mx") {
      const records = await resolver.resolveMx(name);
      return { records: records.map((r) => ({ exchange: r.exchange, priority: r.priority })) };
    }
    if (type === "a") {
      return { records: await resolver.resolve4(name) };
    }
    if (type === "aaaa") {
      return { records: await resolver.resolve6(name) };
    }
    if (type === "txt") {
      const records = await resolver.resolveTxt(name);
      return { records: records.map((chunks) => chunks.join("")) };
    }
    return { unsupported: true };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
