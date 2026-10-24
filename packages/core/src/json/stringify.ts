// JSON serializer for the dynamic Json value. Deterministic: object keys
// keep insertion order; integral numbers print without a fraction; strings
// escape only what RFC 8259 requires (plus lone surrogates).

import { Json, KIND_BOOL, KIND_NULL, KIND_NUM, KIND_STR, KIND_ARR, KIND_OBJ } from "./value.ts";

function escapeInto(parts: string[], s: string): void {
  let chunkStart = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    let replacement: string | null = null;
    if (c == 34) replacement = "\\\"";
    else if (c == 92) replacement = "\\\\";
    else if (c == 10) replacement = "\\n";
    else if (c == 13) replacement = "\\r";
    else if (c == 9) replacement = "\\t";
    else if (c == 8) replacement = "\\b";
    else if (c == 12) replacement = "\\f";
    else if (c < 32) replacement = hexEscape(c);
    else if (c >= 0xd800 && c <= 0xdfff) {
      // Lone surrogates must be escaped to keep the output valid JSON.
      const paired = c < 0xdc00
        ? i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff
        : i > 0 && s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff;
      if (!paired) replacement = hexEscape(c);
      else i++; // valid pair: keep both units unescaped
    }
    if (replacement != null) {
      if (i > chunkStart) parts.push(s.slice(chunkStart, i));
      parts.push(replacement);
      chunkStart = i + 1;
    }
    i++;
  }
  if (chunkStart < s.length) parts.push(s.slice(chunkStart, s.length));
}

function hexEscape(c: i32): string {
  const hex = "0123456789abcdef";
  let out = "\\u";
  for (let shift = 12; shift >= 0; shift -= 4) {
    out += hex.charAt((c >> shift) & 15);
  }
  return out;
}

function numberToString(v: Json): string {
  const n = v.numVal;
  if (isNaN(n) || n == Infinity || n == -Infinity) return "null";
  if (v.numIsInt && n >= -9007199254740992.0 && n <= 9007199254740992.0) {
    return (<i64>n).toString(); // matches JS: String(-0) === "0"
  }
  return n.toString();
}

function writeValue(parts: string[], v: Json): void {
  const kind = v.kind;
  if (kind == KIND_NULL) {
    parts.push("null");
  } else if (kind == KIND_BOOL) {
    parts.push(v.boolVal ? "true" : "false");
  } else if (kind == KIND_NUM) {
    parts.push(numberToString(v));
  } else if (kind == KIND_STR) {
    const s = v.strVal == null ? "" : v.strVal!;
    parts.push("\"");
    escapeInto(parts, s);
    parts.push("\"");
  } else if (kind == KIND_ARR) {
    const items = v.items;
    parts.push("[");
    if (items != null) {
      for (let i = 0; i < items.length; i++) {
        if (i > 0) parts.push(",");
        writeValue(parts, items[i]);
      }
    }
    parts.push("]");
  } else if (kind == KIND_OBJ) {
    const keys = v.keys;
    const vals = v.vals;
    parts.push("{");
    if (keys != null && vals != null) {
      for (let i = 0; i < keys.length; i++) {
        if (i > 0) parts.push(",");
        parts.push("\"");
        escapeInto(parts, keys[i]);
        parts.push("\":");
        writeValue(parts, vals[i]);
      }
    }
    parts.push("}");
  } else {
    parts.push("null");
  }
}

export function stringifyJson(v: Json): string {
  const parts: string[] = [];
  writeValue(parts, v);
  return parts.join("");
}
