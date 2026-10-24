// In-memory account registry. The host persists it through store.exec
// effects against the `registry` store (schema v1, M1); at startup the
// host passes the persisted rows back via sm_init({accounts: [...]}).

import { Json, KIND_ARR, KIND_BOOL, KIND_NUM, KIND_OBJ } from "../json/value.ts";
import { ERR_INVALID_ARG, ERR_NOT_FOUND } from "./errors.ts";

export class Accounts {
  private nextId: i32 = 1;
  private items: Array<Json> = [];

  count(): i32 {
    return this.items.length;
  }

  add(obj: Json): i32 {
    const checked = this.validate(obj);
    if (checked == null) return ERR_INVALID_ARG;
    const copy = checked;
    const id = this.nextId++;
    const record = Json.emptyObj();
    record.setInt("id", <i64>id);
    const keys = copy.keys;
    const vals = copy.vals;
    if (keys != null && vals != null) {
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] == "id") continue;
        record.set(keys[i], vals[i]);
      }
    }
    this.items.push(record);
    return id;
  }

  update(id: i32, obj: Json): i32 {
    const checked = this.validate(obj);
    if (checked == null) return ERR_INVALID_ARG;
    const copy = checked;
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (item.getInt("id", -1) != id) continue;
      const record = Json.emptyObj();
      record.setInt("id", <i64>id);
      const keys = copy.keys;
      const vals = copy.vals;
      if (keys != null && vals != null) {
        for (let k = 0; k < keys.length; k++) {
          if (keys[k] == "id") continue;
          record.set(keys[k], vals[k]);
        }
      }
      this.items[i] = record;
      return 0;
    }
    return ERR_NOT_FOUND;
  }

  remove(id: i32): i32 {
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].getInt("id", -1) == id) {
        this.items.splice(i, 1);
        return 0;
      }
    }
    return ERR_NOT_FOUND;
  }

  list(): Json {
    const out = Json.emptyArr();
    for (let i = 0; i < this.items.length; i++) out.push(this.items[i]);
    return out;
  }

  /** One account by id, or null. */
  get(id: i32): Json | null {
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].getInt("id", -1) == id) return this.items[i];
    }
    return null;
  }

  /** Replace the registry from host-loaded rows; keeps ids monotonic. */
  load(rows: Json): i32 {
    if (rows.kind != KIND_ARR) return ERR_INVALID_ARG;
    this.items = new Array<Json>();
    let maxId = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows.at(i);
      if (row == null || row.kind != KIND_OBJ) return ERR_INVALID_ARG;
      const id = row.getInt("id", -1);
      if (id < 1) return ERR_INVALID_ARG;
      if (id > maxId) maxId = id;
      this.items.push(normalizeAccount(row));
    }
    this.nextId = maxId + 1;
    return 0;
  }

  private validate(obj: Json): Json | null {
    if (obj.kind != KIND_OBJ) return null;
    const address = obj.getString("address", "");
    const host = obj.getString("host", "");
    if (address.length == 0 || host.length == 0) return null;
    const port = obj.getInt("port", 0);
    if (port < 0 || port > 65535) return null;
    // D13 transport fields: only TLS-bearing values are accepted, so
    // requesting plaintext (socket_type "plain") fails account_add/update.
    const socketType = obj.getString("socket_type", "");
    if (socketType.length > 0 && !validTransport(socketType)) return null;
    const smtpSocketType = obj.getString("smtp_socket_type", "");
    if (smtpSocketType.length > 0 && !validTransport(smtpSocketType)) return null;
    return obj;
  }
}

/** A transport value account_add/update accept: implicit TLS or STARTTLS. */
function validTransport(value: string): bool {
  const v = value.trim().toLowerCase();
  return v == "tls" || v == "ssl" || v == "starttls";
}

/**
 * Registry rows come back from the host store with SQLite types (tls as
 * 0/1). Coerce them to the JSON shapes the rest of the core expects.
 */
function normalizeAccount(row: Json): Json {
  const out = Json.emptyObj();
  const keys = row.keys;
  const vals = row.vals;
  if (keys == null || vals == null) return row;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = vals[i];
    if (key == "tls") {
      if (value.kind == KIND_BOOL) out.setBool("tls", value.boolVal);
      else if (value.kind == KIND_NUM) out.setBool("tls", value.numVal != 0);
      else out.setBool("tls", true);
    } else {
      out.set(key, value);
    }
  }
  return out;
}
