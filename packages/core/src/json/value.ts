// Dynamic JSON value. AssemblyScript 0.28 ships no JSON support and no
// exceptions (M0 spike finding), so the core parses and emits JSON with
// its own strict implementation: parse returns null on any error instead
// of throwing. Objects keep insertion order deterministically.

export const KIND_NULL: i8 = 0;
export const KIND_BOOL: i8 = 1;
export const KIND_NUM: i8 = 2;
export const KIND_STR: i8 = 3;
export const KIND_ARR: i8 = 4;
export const KIND_OBJ: i8 = 5;

export class Json {
  kind: i8 = KIND_NULL;
  boolVal: bool = false;
  numVal: f64 = 0;
  numIsInt: bool = false;
  strVal: string | null = null;
  items: Array<Json> | null = null; // array values
  keys: Array<string> | null = null; // object keys, insertion order
  vals: Array<Json> | null = null; // object values, parallel to keys

  static nil(): Json {
    const v = new Json();
    v.kind = KIND_NULL;
    return v;
  }

  static ofBool(b: bool): Json {
    const v = new Json();
    v.kind = KIND_BOOL;
    v.boolVal = b;
    return v;
  }

  static ofNum(n: f64): Json {
    const v = new Json();
    v.kind = KIND_NUM;
    v.numVal = n;
    v.numIsInt = n == Math.floor(n) && Math.abs(n) < 9007199254740992.0 && !isNaN(n);
    return v;
  }

  static ofInt(n: i64): Json {
    const v = new Json();
    v.kind = KIND_NUM;
    v.numVal = <f64>n;
    v.numIsInt = true;
    return v;
  }

  static ofStr(s: string): Json {
    const v = new Json();
    v.kind = KIND_STR;
    v.strVal = s;
    return v;
  }

  static emptyArr(): Json {
    const v = new Json();
    v.kind = KIND_ARR;
    v.items = new Array<Json>();
    return v;
  }

  static emptyObj(): Json {
    const v = new Json();
    v.kind = KIND_OBJ;
    v.keys = new Array<string>();
    v.vals = new Array<Json>();
    return v;
  }

  static err(code: i32, where: string, detail: string): Json {
    const v = Json.emptyObj();
    v.setNum("code", <f64>code);
    v.setStr("where", where);
    v.setStr("detail", detail);
    return v;
  }

  // -- object access ------------------------------------------------------

  get(key: string): Json | null {
    if (this.kind != KIND_OBJ || this.keys == null || this.vals == null) return null;
    const keys = this.keys!;
    const vals = this.vals!;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] == key) return vals[i];
    }
    return null;
  }

  has(key: string): bool {
    return this.get(key) != null;
  }

  getString(key: string, fallback: string): string {
    const v = this.get(key);
    if (v == null || v.kind != KIND_STR) return fallback;
    const s = v.strVal;
    if (s == null) return fallback;
    return s;
  }

  getNum(key: string, fallback: f64): f64 {
    const v = this.get(key);
    if (v == null || v.kind != KIND_NUM) return fallback;
    return v.numVal;
  }

  getInt(key: string, fallback: i32): i32 {
    const v = this.get(key);
    if (v == null || v.kind != KIND_NUM) return fallback;
    return <i32>v.numVal;
  }

  getBool(key: string, fallback: bool): bool {
    const v = this.get(key);
    if (v == null || v.kind != KIND_BOOL) return fallback;
    return v.boolVal;
  }

  set(key: string, value: Json): Json {
    if (this.kind != KIND_OBJ) return this;
    if (this.keys == null || this.vals == null) {
      this.keys = new Array<string>();
      this.vals = new Array<Json>();
    }
    const keys = this.keys!;
    const vals = this.vals!;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] == key) {
        vals[i] = value;
        return this;
      }
    }
    keys.push(key);
    vals.push(value);
    return this;
  }

  setStr(key: string, s: string): Json {
    return this.set(key, Json.ofStr(s));
  }

  setNum(key: string, n: f64): Json {
    return this.set(key, Json.ofNum(n));
  }

  setInt(key: string, n: i64): Json {
    return this.set(key, Json.ofInt(n));
  }

  setBool(key: string, b: bool): Json {
    return this.set(key, Json.ofBool(b));
  }

  // -- array access -------------------------------------------------------

  at(i: i32): Json | null {
    if (this.kind != KIND_ARR || this.items == null) return null;
    const items = this.items!;
    if (i < 0 || i >= items.length) return null;
    return items[i];
  }

  get length(): i32 {
    if (this.kind == KIND_ARR && this.items != null) return this.items!.length;
    if (this.kind == KIND_OBJ && this.keys != null) return this.keys!.length;
    return 0;
  }

  push(value: Json): Json {
    if (this.kind != KIND_ARR) return this;
    if (this.items == null) this.items = new Array<Json>();
    this.items!.push(value);
    return this;
  }
}
