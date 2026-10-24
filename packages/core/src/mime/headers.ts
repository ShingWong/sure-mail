// RFC 5322 header parsing: unfolding, field access, address lists.
// Input is a byte-per-char string (raw message text), so binary stays safe.

import { Json } from "../json/value.ts";
import { decodeEncodedWords } from "./qp.ts";

export class Headers {
  names: string[] = []; // lowercased field names
  values: string[] = []; // unfolded values, parallel to names

  /** Parse a header block (without the blank separator line). */
  static parse(block: string): Headers {
    const h = new Headers();
    const lines = splitLines(block);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length == 0) continue;
      const c0 = line.charCodeAt(0);
      if (c0 == 32 || c0 == 9) {
        // folded continuation
        if (h.values.length > 0) {
          h.values[h.values.length - 1] += " " + trimLeft(line);
        }
        continue;
      }
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      h.names.push(line.substring(0, colon).trim().toLowerCase());
      h.values.push(line.substring(colon + 1).trim());
    }
    return h;
  }

  /** First value (decoded from RFC 2047 words), or null. */
  get(name: string): string | null {
    const low = name.toLowerCase();
    for (let i = 0; i < this.names.length; i++) {
      if (this.names[i] == low) return decodeEncodedWords(this.values[i]);
    }
    return null;
  }

  /** Raw first value, no encoded-word decoding. */
  getRaw(name: string): string | null {
    const low = name.toLowerCase();
    for (let i = 0; i < this.names.length; i++) {
      if (this.names[i] == low) return this.values[i];
    }
    return null;
  }

  getOr(name: string, fallback: string): string {
    const v = this.get(name);
    return v == null ? fallback : v;
  }

  count(): i32 {
    return this.names.length;
  }
}

export function splitLines(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c == 10) {
      let end = i;
      if (end > start && s.charCodeAt(end - 1) == 13) end--;
      out.push(s.substring(start, end));
      i++;
      start = i;
    } else {
      i++;
    }
  }
  if (start < s.length) out.push(s.substring(start, s.length));
  return out;
}

function trimLeft(s: string): string {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c != 32 && c != 9) break;
    i++;
  }
  return s.substring(i, s.length);
}

/**
 * Parse an address header ("To", "Cc", ...) into
 * [{name, address}, ...]: display names decoded, groups flattened.
 */
export function parseAddresses(value: string): Json {
  const out = Json.emptyArr();
  let i = 0;
  const n = value.length;
  while (i < n) {
    // scan for '<' or ',' at top level
    let angleStart = -1;
    let inQuotes = false;
    let j = i;
    let depth = 0;
    for (; j < n; j++) {
      const c = value.charCodeAt(j);
      if (c == 34) inQuotes = !inQuotes;
      else if (inQuotes) continue;
      else if (c == 40) depth++;
      else if (c == 41) depth = depth > 0 ? depth - 1 : 0;
      else if (depth == 0 && c == 60 && angleStart < 0) angleStart = j;
      else if (depth == 0 && (c == 44 || c == 59)) break; // ',' or group ';'
    }
    pushAddress(out, value, i, j, angleStart);
    i = j + 1;
  }
  return out;
}

function pushAddress(out: Json, value: string, from: i32, to: i32, angleStart: i32): void {
  const chunk = value.substring(from, to).trim();
  if (chunk.length == 0) return;
  const addr = Json.emptyObj();
  if (angleStart >= 0) {
    addr.set("name", Json.ofStr(cleanQuoted(value.substring(from, angleStart).trim())));
    const close = value.indexOf(">", angleStart);
    const inside = value.substring(angleStart + 1, close < 0 || close > to ? to : close).trim();
    addr.set("address", Json.ofStr(inside));
  } else {
    const colon = chunk.indexOf(":"); // address group: "Team: a@b.c, c@d.e"
    const bare = colon >= 0 ? chunk.substring(colon + 1).trim() : chunk;
    if (bare.length == 0) return;
    addr.set("name", Json.nil());
    addr.set("address", Json.ofStr(bare));
  }
  out.push(addr);
}

function cleanQuoted(s: string): string {
  let out = s;
  if (out.length >= 2 && out.charCodeAt(0) == 34 && out.charCodeAt(out.length - 1) == 34) {
    out = out.substring(1, out.length - 1);
  }
  for (let i = 0; i < out.length; i++) {
    if (out.charCodeAt(i) == 92 && i + 1 < out.length) {
      out = out.substring(0, i) + out.substring(i + 1);
    }
  }
  return out.trim();
}
