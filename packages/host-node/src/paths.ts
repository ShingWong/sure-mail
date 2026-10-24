// Data directory layout shared by every Node host (CLI in packages/cli).
// SURE_MAIL_HOME overrides the root (tests point it at temp dirs).

import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  root: string;
  registryDb: string;
  accountsDir: string;
}

export function dataPaths(root?: string): Paths {
  const base = root ?? process.env["SURE_MAIL_HOME"] ?? join(homedir(), ".sure-mail");
  return {
    root: base,
    registryDb: join(base, "registry.sqlite"),
    accountsDir: join(base, "accounts"),
  };
}

/** Map a store.exec `store` name to its SQLite file path. */
export function storePath(paths: Paths, store: string): string {
  if (store === "registry") return paths.registryDb;
  if (store.startsWith("account:")) {
    const id = Number(store.slice("account:".length));
    if (!Number.isInteger(id) || id < 1) throw new Error(`bad store name: ${store}`);
    return join(paths.accountsDir, String(id), "mail.sqlite");
  }
  throw new Error(`unknown store: ${store}`);
}
