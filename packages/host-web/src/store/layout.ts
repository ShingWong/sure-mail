// Store name → SQLite path, mirroring the Node host's paths.ts exactly: the
// layout is part of the core contract ("registry" | "account:<id>"), not a
// host choice. Matching host-node's paths means the CLI and the browser
// agree on where each account's data lives, so a future export/import or a
// file-backed browser build stays compatible. Under the OPFS sahpool VFS the
// directory segments are virtual (sahpool flattens to a pool of slots), but
// the path string is what keys the mapping — so it must be distinct per
// account either way.

/** Data root the store names resolve under. */
const ROOT = "sure-mail";

/** Map a store.exec `store` name to its SQLite path (host-node parity). */
export function storePath(store: string): string {
  if (store === "registry") return `${ROOT}/registry.sqlite`;
  if (store.startsWith("account:")) {
    const id = Number(store.slice("account:".length));
    if (!Number.isInteger(id) || id < 1) throw new Error(`bad store name: ${store}`);
    return `${ROOT}/accounts/${id}/mail.sqlite`;
  }
  throw new Error(`unknown store: ${store}`);
}
