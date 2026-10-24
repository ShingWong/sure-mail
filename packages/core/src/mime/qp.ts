// Quoted-printable transfer decoding (RFC 2045): =XX hex escapes, soft
// line breaks. Output is bytes (one charset unit per byte) — charset
// decoding goes through the host decode_text port afterwards. RFC 2047
// encoded-word decoding lives here too (Q and B words).

import { decode_text } from "../runtime/ports.ts";
import { b64Decode } from "../encoding/base64.ts";

export function qpDecodeBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length); // decoded is never longer than encoded
  let o = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c == 61) { // '='
      if (i + 2 < n) {
        const hi = hexVal(s.charCodeAt(i + 1));
        const lo = hexVal(s.charCodeAt(i + 2));
        if (hi >= 0 && lo >= 0) {
          out[o++] = <u8>((hi << 4) | lo);
          i += 3;
          continue;
        }
      }
      if (i + 2 == n || (i + 1 < n && (s.charCodeAt(i + 1) == 13 || s.charCodeAt(i + 1) == 10))) {
        // soft line break: "=\r\n" or "=\n" (or trailing "=" at end)
        i++;
        if (i < n && s.charCodeAt(i) == 13) i++;
        if (i < n && s.charCodeAt(i) == 10) i++;
        continue;
      }
      out[o++] = 61; // literal '='
      i++;
      continue;
    }
    out[o++] = <u8>(c & 0xff);
    i++;
  }
  return out.slice(0, o);
}

function hexVal(c: i32): i32 {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

/** Decode RFC 2047 encoded-words in-place in a header value (=?charset?B|Q?...?=). */
export function decodeEncodedWords(s: string): string {
  if (s.indexOf("=?") < 0) return s;
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const start = s.indexOf("=?", i);
    if (start < 0) {
      out += s.substring(i, n);
      break;
    }
    out += s.substring(i, start);
    const end = s.indexOf("?=", start + 2);
    if (end < 0) {
      out += s.substring(start, n);
      break;
    }
    const body = s.substring(start + 2, end);
    // charset?encoding?text
    const q1 = body.indexOf("?");
    const q2 = q1 < 0 ? -1 : body.indexOf("?", q1 + 1);
    if (q1 < 0 || q2 < 0) {
      out += s.substring(start, end + 2);
      i = end + 2;
      continue;
    }
    const charset = body.substring(0, q1);
    const encoding = body.substring(q1 + 1, q2).toUpperCase();
    const text = body.substring(q2 + 1);
    if (encoding == "Q" || encoding == "q") {
      out += qEncodedToText(text, charset);
    } else if (encoding == "B" || encoding == "b") {
      out += b64WordToText(text, charset);
    } else {
      out += s.substring(start, end + 2);
      i = end + 2;
      continue;
    }
    i = end + 2;
    // RFC 2047: whitespace BETWEEN adjacent encoded-words is dropped;
    // whitespace before ordinary text is kept.
    let j = i;
    while (j < n && (s.charCodeAt(j) == 32 || s.charCodeAt(j) == 9)) j++;
    if (j > i && j + 1 < n && s.charAt(j) == "=" && s.charAt(j + 1) == "?") i = j;
  }
  return out;
}

function qEncodedToText(text: string, charset: string): string {
  const bytes = new Uint8Array(text.length);
  let o = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c == 95) { // '_' means space
      bytes[o++] = 32;
    } else if (c == 61 && i + 2 < text.length) {
      const hi = hexVal(text.charCodeAt(i + 1));
      const lo = hexVal(text.charCodeAt(i + 2));
      if (hi >= 0 && lo >= 0) {
        bytes[o++] = <u8>((hi << 4) | lo);
        i += 2;
      } else {
        bytes[o++] = 61;
      }
    } else {
      bytes[o++] = <u8>(c & 0xff);
    }
  }
  return decodeWordBytes(bytes.slice(0, o), charset);
}

function b64WordToText(text: string, charset: string): string {
  const cleaned = stripSpace(text);
  const bytes = b64Decode(cleaned);
  if (bytes == null) return text;
  return decodeWordBytes(bytes, charset);
}

function stripSpace(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c != 32 && c != 9 && c != 13 && c != 10) out += s.charAt(i);
  }
  return out;
}

function decodeWordBytes(bytes: Uint8Array, charset: string): string {
  return decode_text(bytes.dataStart, bytes.length, charset);
}
