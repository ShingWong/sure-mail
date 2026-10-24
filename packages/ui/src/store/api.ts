// Adapter helper for the core-backed stores — NOT a store implementation.
// `@shing.wong/sure-state` owns the entity store (zero runtime deps, see its
// `createStateStore`); this only fills in the API methods a read-only view
// never implements, so an unsupported write rejects loudly instead of
// silently resolving `undefined`.
import type { EntityApi } from "@shing.wong/sure-state/core";

export function api<T, TCreate = Partial<T>, TUpdate = Partial<T>>(
  impl: Partial<EntityApi<T, TCreate, TUpdate>>,
): EntityApi<T, TCreate, TUpdate> {
  const unsupported = (op: string) => () => Promise.reject(new Error(`${op} is not supported`));
  return {
    list: impl.list ?? (() => Promise.resolve([])),
    getById: impl.getById ?? unsupported("getById"),
    create: impl.create ?? unsupported("create"),
    update: impl.update ?? unsupported("update"),
    remove: impl.remove ?? unsupported("remove"),
  };
}
