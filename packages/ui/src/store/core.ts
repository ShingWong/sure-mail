// Thin core-op helpers. The store wrappers and the shell never compose SQL —
// they call core-owned named queries through `store.query` (D2/D10) and run
// the reactor with the host from packages/host-web.
import type { MailHost, OpStatus } from "@shing.wong/sure-mail-host-web";

export interface QueryResult {
  rows: Record<string, unknown>[];
  changes: number;
  insertId: number;
}

export function describeStatus(status: OpStatus): string {
  if (status.error) return `${status.error.where}: ${status.error.detail} (code ${status.error.code})`;
  return status.state;
}

/** Run one core-owned named query and return its rows. */
export async function runQuery(
  host: MailHost,
  store: string,
  query: string,
  args?: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<QueryResult> {
  const payload: Record<string, unknown> = { store, query };
  if (args) payload.args = args;
  const opId = host.startOp("store.query", payload);
  if (opId < 0) throw new Error(`store.query ${query} rejected (${opId})`);
  const status = await host.drive(opId, { timeoutMs });
  if (status.state !== "done") throw new Error(`store.query ${query} failed: ${describeStatus(status)}`);
  const result = status.result as Partial<QueryResult> | null | undefined;
  return {
    rows: result?.rows ?? [],
    changes: result?.changes ?? 0,
    insertId: result?.insertId ?? 0,
  };
}

/** Run any core op through the reactor and require success. */
export async function runOp(
  host: MailHost,
  kind: string,
  args: Record<string, unknown> = {},
  timeoutMs = 60000,
): Promise<Record<string, unknown>> {
  const opId = host.startOp(kind, args);
  if (opId < 0) throw new Error(`${kind} rejected (${opId})`);
  const status = await host.drive(opId, { timeoutMs });
  if (status.state !== "done") throw new Error(`${kind} failed: ${describeStatus(status)}`);
  return (status.result ?? {}) as Record<string, unknown>;
}
