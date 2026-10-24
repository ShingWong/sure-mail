// MIME parsing: Content-Type tree, transfer decoding, text/attachment
// extraction, structure JSON, thread keys. Input is a raw message as a
// byte-per-char string (binary-safe); text parts go through the host
// decode_text port with their declared charset.

import { Json, KIND_ARR, KIND_STR } from "../json/value.ts";
import { Headers, parseAddresses } from "./headers.ts";
import { qpDecodeBytes } from "./qp.ts";
import { b64Decode } from "../encoding/base64.ts";
import { decode_text } from "../runtime/ports.ts";

export class MimePart {
  type: string = "text";
  subtype: string = "plain";
  params: Json = Json.emptyObj();
  headers: Headers = Headers.parse("");
  disposition: string = "";
  filename: string | null = null;
  charset: string = "utf-8";
  encoding: string = "7bit";
  parts: MimePart[] = [];
  body: string = ""; // byte-per-char decoded-transfer text (leaf bodies)
  isLeaf: bool = true;
}

/** Fully parsed message: headers + decoded bodies + attachments. */
export class ParsedMessage {
  headers: Headers = Headers.parse("");
  headersJson: Json = Json.emptyObj();
  bodyText: string = "";
  bodyHtml: string = "";
  structure: Json = Json.emptyObj();
  attachments: Json = Json.emptyArr();
  threadKey: string = "";
}

function paramValue(params: string, name: string): string | null {
  // name=value; name2="quoted value" — also matches RFC 2231 starred
  // forms (name*=charset'lang'pct-encoded), which win over plain when
  // both appear.
  let i = 0;
  let plain: string | null = null;
  while (i < params.length) {
    let eq = params.indexOf("=", i);
    if (eq < 0) return plain;
    const rawKey = params.substring(i, eq).trim().toLowerCase();
    const starred = rawKey.endsWith("*");
    const key = starred ? rawKey.substring(0, rawKey.length - 1) : rawKey;
    let j = eq + 1;
    let value: string;
    if (j < params.length && params.charCodeAt(j) == 34) {
      j++;
      let out = "";
      while (j < params.length && params.charCodeAt(j) != 34) {
        if (params.charCodeAt(j) == 92 && j + 1 < params.length) j++;
        out += params.charAt(j);
        j++;
      }
      value = out;
      j++; // closing quote
    } else {
      let semi = params.indexOf(";", j);
      if (semi < 0) semi = params.length;
      value = params.substring(j, semi).trim();
      j = semi;
    }
    if (key == name) {
      if (starred) {
        const decoded = decodeRfc2231(value);
        if (decoded != null) return decoded; // starred wins immediately
      } else if (plain == null) {
        plain = value;
      }
    }
    let next = params.indexOf(";", j);
    if (next < 0) return plain;
    i = next + 1;
  }
  return plain;
}

/**
 * RFC 2231 value: `charset'language'pct-encoded` -> text (UTF-8 bytes
 * decoded through the host charset port). Returns null when malformed.
 */
function decodeRfc2231(value: string): string | null {
  const b1 = value.indexOf("'");
  if (b1 < 0) return value;
  const b2 = value.indexOf("'", b1 + 1);
  if (b2 < 0) return null;
  const charset = value.substring(0, b1).toLowerCase();
  const encoded = value.substring(b2 + 1);
  const bytes: number[] = [];
  let i = 0;
  while (i < encoded.length) {
    const c = encoded.charAt(i);
    if (c == "%") {
      const hi = hexVal(encoded.charCodeAt(i + 1));
      const lo = hexVal(encoded.charCodeAt(i + 2));
      if (hi < 0 || lo < 0) return null;
      bytes.push((hi << 4) | lo);
      i += 3;
    } else {
      bytes.push(encoded.charCodeAt(i) & 0xff);
      i++;
    }
  }
  const arr = new Uint8Array(bytes.length);
  for (let k = 0; k < bytes.length; k++) arr[k] = <u8>bytes[k];
  return decode_text(arr.dataStart, arr.length, charset.length > 0 ? charset : "utf-8");
}

function hexVal(c: i32): i32 {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

class ContentType {
  type: string = "text";
  subtype: string = "";
  params: Json = Json.emptyObj();
}

function parseContentType(value: string): ContentType {
  const out = new ContentType();
  const semi = value.indexOf(";");
  const main = (semi < 0 ? value : value.substring(0, semi)).trim().toLowerCase();
  const slash = main.indexOf("/");
  out.type = slash < 0 ? main : main.substring(0, slash);
  out.subtype = slash < 0 ? "" : main.substring(slash + 1);
  if (semi >= 0) {
    const rest = value.substring(semi + 1);
    const boundary = paramValue(rest, "boundary");
    if (boundary != null) out.params.setStr("boundary", boundary);
    const charset = paramValue(rest, "charset");
    if (charset != null) out.params.setStr("charset", charset);
    const name = paramValue(rest, "name");
    if (name != null) out.params.setStr("name", name);
  }
  return out;
}

/** Split a multipart body into part texts on its boundary lines. */
export function splitMultipart(body: string, boundary: string): string[] | null {
  const marker = "--" + boundary;
  const out: string[] = [];
  let i = 0;
  let currentStart = -1;
  while (i <= body.length) {
    // find start of line
    if (i != 0 && body.charCodeAt(i - 1) != 10) {
      i++;
      continue;
    }
    if (body.startsWith(marker, i)) {
      const after = i + marker.length;
      const isClose = body.startsWith("--", after);
      if (currentStart >= 0) out.push(trimDelimCrlf(body.substring(currentStart, i)));
      if (isClose) return out;
      // skip marker line's CRLF
      let j = after;
      while (j < body.length && body.charCodeAt(j) != 10) j++;
      currentStart = j + 1 > body.length ? body.length : j + 1;
      i = currentStart;
      continue;
    }
    i++;
  }
  if (currentStart >= 0) out.push(trimDelimCrlf(body.substring(currentStart, body.length)));
  return null;
}

/** The CRLF before a boundary marker belongs to the delimiter. */
function trimDelimCrlf(s: string): string {
  let end = s.length;
  if (end > 0 && s.charCodeAt(end - 1) == 10) end--;
  if (end > 0 && s.charCodeAt(end - 1) == 13) end--;
  return s.substring(0, end);
}

function decodeTransfer(part: MimePart): string {
  const enc = part.encoding.toLowerCase();
  if (enc == "base64") {
    const cleaned = stripCrlf(part.body);
    const bytes = b64Decode(cleaned);
    if (bytes == null) return part.body;
    return bytesToLatin1(bytes);
  }
  if (enc == "quoted-printable") {
    return bytesToLatin1(qpDecodeBytes(part.body));
  }
  return part.body;
}

function stripCrlf(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c != 13 && c != 10) out += s.charAt(i);
  }
  return out;
}

function bytesToLatin1(bytes: Uint8Array): string {
  const codes: i32[] = new Array<i32>(bytes.length);
  for (let i = 0; i < bytes.length; i++) codes[i] = bytes[i];
  return String.fromCharCodes(codes);
}

/** Decode a text/* part's bytes through the host charset port. */
function decodeTextPart(part: MimePart): string {
  const raw = decodeTransfer(part);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = <u8>(raw.charCodeAt(i) & 0xff);
  let charset = part.charset.toLowerCase();
  if (charset == "us-ascii") charset = "utf-8";
  return decode_text(bytes.dataStart, bytes.length, charset);
}

function parsePart(headersBlock: string, body: string): MimePart {
  const part = new MimePart();
  part.headers = Headers.parse(headersBlock);
  const ct = parseContentType(part.headers.getOr("content-type", "text/plain; charset=utf-8"));
  part.type = ct.type;
  part.subtype = ct.subtype;
  part.params = ct.params;
  part.charset = ct.params.getString("charset", "utf-8");
  part.encoding = part.headers.getOr("content-transfer-encoding", "7bit").trim();
  const dispRaw = part.headers.getOr("content-disposition", "");
  const semi = dispRaw.indexOf(";");
  part.disposition = (semi < 0 ? dispRaw : dispRaw.substring(0, semi)).trim().toLowerCase();
  if (semi >= 0) {
    part.filename = paramValue(dispRaw.substring(semi + 1), "filename");
  }
  part.body = body;
  part.isLeaf = true;

  if (part.type == "multipart") {
    const boundary = ct.params.get("boundary");
    const b = boundary != null && boundary.kind == KIND_STR ? boundary.strVal : null;
    if (b != null && b.length > 0) {
      const chunks = splitMultipart(body, b);
      if (chunks != null) {
        part.isLeaf = false;
        for (let i = 0; i < chunks.length; i++) {
          const split = headerBodySplit(chunks[i]);
          part.parts.push(parsePart(split.headers, split.body));
        }
      }
    }
    if (part.filename == null) {
      const nameParam = ct.params.get("name");
      if (nameParam != null && nameParam.kind == KIND_STR && nameParam.strVal != null) {
        part.filename = nameParam.strVal;
      }
    }
  } else if (part.filename == null) {
    const name = part.params.get("name");
    if (name != null && name.kind == KIND_STR && name.strVal != null) part.filename = name.strVal;
  }
  return part;
}

/** Split "headers CRLF CRLF body". */
export class HeaderBody {
  headers: string = "";
  body: string = "";
}

export function headerBodySplit(raw: string): HeaderBody {
  const out = new HeaderBody();
  let i = raw.indexOf("\r\n\r\n");
  if (i >= 0) {
    out.headers = raw.substring(0, i);
    out.body = raw.substring(i + 4);
    return out;
  }
  i = raw.indexOf("\n\n");
  if (i >= 0) {
    out.headers = raw.substring(0, i);
    out.body = raw.substring(i + 2);
    return out;
  }
  out.headers = raw;
  return out;
}

function structureOf(part: MimePart): Json {
  const s = Json.emptyObj();
  s.setStr("type", part.type);
  s.setStr("subtype", part.subtype);
  s.set("params", part.params);
  s.setStr("encoding", part.encoding.toLowerCase());
  if (part.disposition.length > 0) s.setStr("disposition", part.disposition);
  const fn = part.filename;
  if (fn != null) s.setStr("filename", fn);
  if (!part.isLeaf) {
    const kids = Json.emptyArr();
    for (let i = 0; i < part.parts.length; i++) kids.push(structureOf(part.parts[i]));
    s.set("parts", kids);
  }
  return s;
}

function isAttachment(part: MimePart): bool {
  if (part.disposition == "attachment") return true;
  const fn = part.filename;
  if (fn != null && fn.length > 0) return true;
  if (part.type != "text" && part.type != "multipart" && part.type.length > 0) {
    // non-text leafs rendered inline are still downloadable content
    if (part.isLeaf && part.type != "message") return true;
  }
  return false;
}

function walkDecoded(part: MimePart, out: ParsedMessage): void {
  if (part.type == "multipart" && !part.isLeaf) {
    let sawText = false;
    let sawHtml = false;
    for (let i = 0; i < part.parts.length; i++) {
      const child = part.parts[i];
      if (child.type == "text" && child.isLeaf && !isAttachment(child)) {
        const text = decodeTextPart(child);
        if (child.subtype == "html" && !sawHtml) {
          if (out.bodyHtml.length == 0) out.bodyHtml = text;
          sawHtml = true;
        } else if (child.subtype != "html" && !sawText) {
          if (out.bodyText.length == 0) out.bodyText = text;
          sawText = true;
        }
      } else {
        walkDecoded(child, out);
      }
    }
    return;
  }
  if (isAttachment(part) && part.type != "message") {
    const a = Json.emptyObj();
    let fn = part.filename;
    if (fn == null || fn.length == 0) fn = part.subtype + "." + part.type;
    a.setStr("filename", fn);
    a.setStr("contentType", part.type + "/" + part.subtype);
    const decoded = decodeTransfer(part);
    a.setInt("size", decoded.length);
    out.attachments.push(a);
    return;
  }
  if (part.type == "text" && part.isLeaf) {
    const text = decodeTextPart(part);
    if (part.subtype == "html") {
      if (out.bodyHtml.length == 0) out.bodyHtml = text;
    } else if (out.bodyText.length == 0) {
      out.bodyText = text;
    }
    return;
  }
}

/** Parse a full raw message. */
export function parseMessage(raw: string): ParsedMessage {
  const out = new ParsedMessage();
  const split = headerBodySplit(raw);
  const root = parsePart(split.headers, split.body);
  out.headers = root.headers;
  out.structure = structureOf(root);
  walkDecoded(root, out);

  const h = Json.emptyObj();
  h.setStr("subject", root.headers.getOr("subject", ""));
  h.set("from", parseAddresses(root.headers.getOr("from", "")));
  h.set("to", parseAddresses(root.headers.getOr("to", "")));
  h.set("cc", parseAddresses(root.headers.getOr("cc", "")));
  h.set("replyTo", parseAddresses(root.headers.getOr("reply-to", "")));
  h.setStr("date", root.headers.getOr("date", ""));
  h.setStr("messageId", root.headers.getOr("message-id", ""));
  h.setStr("inReplyTo", root.headers.getOr("in-reply-to", ""));
  h.setStr("references", root.headers.getOr("references", ""));
  out.headersJson = h;

  out.threadKey = threadKeyOf(root.headers);
  return out;
}

/** Root of the thread: first References id, else In-Reply-To, else own. */
export function threadKeyOf(headers: Headers): string {
  const refs = headers.getRaw("references");
  if (refs != null && refs.length > 0) {
    const first = firstMessageId(refs);
    if (first.length > 0) return first;
  }
  const irt = headers.getRaw("in-reply-to");
  if (irt != null && irt.length > 0) {
    const first = firstMessageId(irt);
    if (first.length > 0) return first;
  }
  const own = headers.getRaw("message-id");
  if (own != null && own.length > 0) return firstMessageId(own);
  return "";
}

function firstMessageId(s: string): string {
  let i = s.indexOf("<");
  while (i >= 0) {
    const close = s.indexOf(">", i + 1);
    if (close < 0) break;
    const id = s.substring(i + 1, close).trim().toLowerCase();
    if (id.length > 0) return id;
    i = s.indexOf("<", close + 1);
  }
  return s.trim().toLowerCase();
}

/** First "Name <addr>" display for list columns. */
export function firstAddress(addrs: Json): string {
  if (addrs.kind != KIND_ARR || addrs.length == 0) return "";
  const a = addrs.at(0);
  if (a == null) return "";
  const name = a.getString("name", "");
  const address = a.getString("address", "");
  if (name.length > 0) return name;
  return address;
}

/** Address list as a compact "a@b, c@d" string (address book style). */
export function addressList(addrs: Json): string {
  if (addrs.kind != KIND_ARR) return "";
  let out = "";
  for (let i = 0; i < addrs.length; i++) {
    const a = addrs.at(i);
    if (a == null) continue;
    if (out.length > 0) out += ", ";
    const name = a.getString("name", "");
    const address = a.getString("address", "");
    out += name.length > 0 ? name + " <" + address + ">" : address;
  }
  return out;
}

