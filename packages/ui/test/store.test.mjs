// Offline tests for the core-backed store layer: the entity store from
// @shing.wong/sure-state (driven the same `server-first` way the app drives
// it), the api adapter helper, and the row helpers. No DOM, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEntityStore } from "@shing.wong/sure-state/core";
import { api } from "../src/store/api.ts";
import { publish } from "../src/store/stores.ts";
import {
  addressLine,
  formatSize,
  htmlToText,
  isFlagged,
  isUnread,
  toMessage,
  toMessageBody,
} from "../src/store/rows.ts";

function widgetStore(initial = []) {
  let rows = initial.map((row) => ({ ...row }));
  const calls = [];
  const store = createEntityStore({
    name: "widgets",
    sync: "server-first",
    api: api({
      list: async () => {
        calls.push("list");
        return rows.map((row) => ({ ...row }));
      },
      getById: async (id) => ({ ...rows.find((row) => row.id === id) }),
      create: async (data) => {
        const created = { id: String(rows.length + 1), ...data };
        rows.push(created);
        return created;
      },
      update: async (id, data) => {
        const updated = { ...rows.find((row) => row.id === id), ...data };
        rows = rows.map((row) => (row.id === id ? updated : row));
        return updated;
      },
      remove: async (id) => {
        rows = rows.filter((row) => row.id !== id);
      },
    }),
  });
  return { store, calls };
}

test("createEntityStore: fetch, select, create, update, delete (server-first)", async () => {
  const { store } = widgetStore([{ id: "1", name: "alpha", size: 1 }]);
  await store.fetch();
  assert.deepEqual(store.items.map((w) => w.name), ["alpha"]);
  assert.equal(store.isLoading, false);

  store.select("1");
  assert.equal(store.selectedId, "1");
  assert.equal(store.selected.name, "alpha");

  await store.create({ name: "beta", size: 2 });
  assert.deepEqual(store.items.map((w) => w.name).sort(), ["alpha", "beta"]);

  await store.update("1", { name: "alpha2" });
  assert.equal(store.items.find((w) => w.id === "1").name, "alpha2");

  await store.delete("2");
  assert.deepEqual(store.items.map((w) => w.id), ["1"]);
});

test("createEntityStore: subscribe fires on every state change, and unsubscribes", async () => {
  const { store } = widgetStore([{ id: "1", name: "a", size: 0 }]);
  const seen = [];
  const unsubscribe = store.subscribe((state) => seen.push(state.isLoading));
  await store.fetch();
  assert.ok(seen.length >= 1);
  const count = seen.length;
  unsubscribe();
  await store.fetch();
  assert.equal(seen.length, count);
});

test("publish: seeds the store from core-read rows without an API round-trip", async () => {
  const { store, calls } = widgetStore([{ id: "1", name: "alpha", size: 1 }]);
  publish(store, [{ id: "9", name: "from-core", size: 0 }]);
  assert.deepEqual(store.items.map((w) => w.name), ["from-core"]);
  assert.equal(store.isLoading, false);
  assert.equal(store.error, null);
  assert.deepEqual(calls, [], "no api.list call for a direct publish");
});

test("createEntityStore: surfaces api errors without throwing state away", async () => {  const store = createEntityStore({
    name: "broken",
    api: api({
      list: async () => {
        throw new Error("boom");
      },
    }),
  });
  await assert.rejects(() => store.fetch(), /boom/);
  assert.equal(store.error, "boom");
  assert.equal(store.isLoading, false);
  store.clearError();
  assert.equal(store.error, null);
});

test("rows: unread/flagged derive from the stored flag list", () => {
  assert.equal(isUnread("[]"), true);
  assert.equal(isUnread('["\\Seen"]'), false);
  assert.equal(isFlagged('["\\Flagged"]'), true);
  assert.equal(isFlagged("[]"), false);
});

test("rows: htmlToText keeps line structure and decodes entities", () => {
  assert.equal(htmlToText("<p>Hi&amp; bye</p><p>Second<br>line</p>"), "Hi& bye\nSecond\nline");
});

test("rows: formatSize and addressLine", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(2048), "2.0 KB");
  assert.equal(formatSize(3 * 1024 * 1024), "3.0 MB");
  assert.equal(
    addressLine([{ name: "Alice", address: "alice@example.com" }, { address: "bob@example.com" }]),
    "Alice <alice@example.com>, bob@example.com",
  );
  assert.equal(addressLine(undefined), "");
});

test("rows: toMessage keys by folder:uid", () => {
  const message = toMessage({ uid: 5, flags: "[]", internaldate: 1700000000000, size: 12, subject: "s", fromaddr: "a@b" }, "INBOX");
  assert.equal(message.id, "INBOX:5");
  assert.equal(message.uid, 5);
  assert.equal(message.folder, "INBOX");
  assert.equal(isUnread(message.flags), true);
});

test("rows: toMessageBody prefers body_text, falls back to stripped HTML", () => {
  const withText = toMessageBody({ uid: 1, body_text: "plain", body_html: "<p>html</p>", attachments: "[]" }, "INBOX");
  assert.equal(withText.bodyText, "plain");
  const htmlOnly = toMessageBody({ uid: 2, body_html: "<p>only html</p>", attachments: '[{"filename":"a.pdf","size":10}]' }, "INBOX");
  assert.equal(htmlOnly.bodyText, "only html");
  assert.deepEqual(htmlOnly.attachments, [{ filename: "a.pdf", size: 10 }]);
});
