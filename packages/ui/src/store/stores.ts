// Core-backed entity stores: sure-state's `createEntityStore` (from
// @shing.wong/sure-state — zero runtime deps) driven by an API that runs
// core.wasm ops (named store queries) rather than HTTP. The local SQLite file
// is the source of truth, so every list re-reads it through the reactor.
import type { MailHost } from "@shing.wong/sure-mail-host-web";
import {
  createEntityStore,
  type EntityStore,
  type EntityStoreState,
  type EntityStoreStore,
} from "@shing.wong/sure-state/core";
import { api } from "./api.ts";
import { runQuery } from "./core.ts";
import {
  toAccount,
  toFolder,
  toMessage,
  toMessageBody,
  type AccountRow,
  type FolderRow,
  type MessageBody,
  type MessageRow,
} from "./rows.ts";

export const REGISTRY = "registry";

/**
 * A store as `createEntityStore` returns it: the entity API plus the external
 * store surface (`getState`/`setState`/`subscribe`).
 */
export type CoreEntityStore<T extends { id: string }> = EntityStore<T, Partial<T>, Partial<T>> &
  EntityStoreStore<EntityStoreState<T>>;

/**
 * Publish items read straight from the authoritative local core, with no API
 * round-trip (the core-result seed path: the CLI boots the same way,
 * registry rows -> `core.init`).
 */
export function publish<T>(store: EntityStoreStore<EntityStoreState<T>>, items: T[]): void {
  store.setState({ items, isLoading: false, error: null });
}

// `server-first` is deliberate: the local store is authoritative, so after a
// write we re-read rather than trust an optimistic echo.
const CORE_SYNC = { sync: "server-first" } as const;

export function accountStore(host: MailHost): CoreEntityStore<AccountRow> {
  return createEntityStore<AccountRow>({
    name: "accounts",
    ...CORE_SYNC,
    api: api<AccountRow>({
      list: async () => (await runQuery(host, REGISTRY, "accounts")).rows.map(toAccount),
    }),
  });
}

export function folderStore(host: MailHost, accountId: number): CoreEntityStore<FolderRow> {
  const store = `account:${accountId}`;
  const args = { account: accountId };
  return createEntityStore<FolderRow>({
    name: "folders",
    ...CORE_SYNC,
    api: api<FolderRow>({
      list: async () => (await runQuery(host, store, "folders", args)).rows.map(toFolder),
    }),
  });
}

export function messageStore(host: MailHost, accountId: number, folder: string, limit = 100): CoreEntityStore<MessageRow> {
  const store = `account:${accountId}`;
  const args = { account: accountId, folder, limit };
  return createEntityStore<MessageRow>({
    name: "messages",
    ...CORE_SYNC,
    api: api<MessageRow>({
      list: async () => (await runQuery(host, store, "messages", args)).rows.map((row) => toMessage(row, folder)),
    }),
  });
}

/** One full message body + attachment metadata for the reading pane. */
export async function loadMessageBody(
  host: MailHost,
  accountId: number,
  folder: string,
  uid: number,
): Promise<MessageBody | null> {
  const result = await runQuery(host, `account:${accountId}`, "message", { account: accountId, folder, uid });
  const row = result.rows[0];
  return row ? toMessageBody(row, folder) : null;
}

/** Local full-text search (FTS5) across the account's stored messages. */
export async function searchMessages(
  host: MailHost,
  accountId: number,
  q: string,
  limit = 50,
): Promise<MessageRow[]> {
  const result = await runQuery(host, `account:${accountId}`, "search", { q, limit });
  return result.rows.map((row) => toMessage(row, String(row.folder ?? "")));
}

export interface DraftInput {
  account: number;
  subject: string;
  fromaddr: string;
  toaddrs: string;
  ccaddrs?: string;
  bccaddrs?: string;
  body_text: string;
  now: number;
}

/** Save a compose draft; returns the new draft id. */
export async function saveDraft(host: MailHost, input: DraftInput): Promise<number> {
  const result = await runQuery(host, `account:${input.account}`, "draft_save", {
    account: input.account,
    subject: input.subject,
    fromaddr: input.fromaddr,
    toaddrs: input.toaddrs,
    ccaddrs: input.ccaddrs ?? "[]",
    bccaddrs: input.bccaddrs ?? "[]",
    body_text: input.body_text,
    body_html: "",
    attachments: "[]",
    now: input.now,
  });
  return result.insertId;
}
