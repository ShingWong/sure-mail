// The store layer: sure-state's entity store (re-exported for consumers) plus
// the core-backed adapters, the API helper, and the row mapping.
export {
  createEntityStore,
  type EntityApi,
  type EntityStore,
  type EntityStoreConfig,
  type EntityStoreState,
  type EntityStoreStore,
  type MutationEvent,
  type SyncStrategy,
} from "@shing.wong/sure-state/core";
export { api } from "./api.ts";
export { runQuery, runOp, describeStatus, type QueryResult } from "./core.ts";
export * from "./rows.ts";
export {
  REGISTRY,
  publish,
  accountStore,
  folderStore,
  messageStore,
  loadMessageBody,
  searchMessages,
  saveDraft,
  type CoreEntityStore,
  type DraftInput,
} from "./stores.ts";
