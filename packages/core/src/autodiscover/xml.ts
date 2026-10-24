// Minimal XML subset parser for Thunderbird ISPDB `clientConfig` documents
// (M2 strategy 2). AssemblyScript has no
// DOMParser, so the core tokenizes by hand and extracts only what
// autodiscover needs: incomingServer/outgoingServer with hostname, port,
// socketType, auth (`<authentication>`/`<authMethod>`), username.
//
// Hostile input is expected — namespaces, CDATA, comments, processing
// instructions, DOCTYPE, entities, attributes, missing or mismatched tags,
// truncated garbage — and must never throw (AS has no exceptions) or loop
// forever: every branch advances the cursor or stops.

import { Json } from "../json/value.ts";

/** One parsed server element (raw field text; mapping happens in ispdb.ts). */
export class XmlServer {
  type: string = ""; // "imap" | "smtp" | "pop3" | ... (type attr, else element name)
  hostname: string = "";
  port: string = "";
  socketType: string = "";
  auth: string = ""; // from <authentication> or <authMethod>
  username: string = "";

  constructor(type: string) {
    this.type = type;
  }
}

function isWs(c: i32): bool {
  return c == 32 || c == 9 || c == 10 || c == 13;
}

/** Element name: strip the namespace prefix, lowercase (`<ns:incomingServer>`). */
function readName(s: string): string {
  let i = 0;
  if (s.startsWith("/")) i = 1;
  let end = i;
  while (end < s.length) {
    const c = s.charCodeAt(end);
    if (isWs(c) || c == 47) break; // ws or '/'
    end++;
  }
  if (end == i) return "";
  let name = s.slice(i, end);
  const colon = name.lastIndexOf(":");
  if (colon >= 0) name = name.slice(colon + 1);
  return name.toLowerCase();
}

/** Attribute value: `type="imap"` (single/double/unquoted, case-tolerant). */
function attr(tag: string, key: string): string {
  const lower = tag.toLowerCase();
  const k = key.toLowerCase();
  let i = 0;
  while (i >= 0) {
    const at = lower.indexOf(k, i);
    if (at < 0) return "";
    const beforeOk = at == 0 || isWs(tag.charCodeAt(at - 1));
    let j = at + k.length;
    while (j < lower.length && isWs(lower.charCodeAt(j))) j++;
    if (beforeOk && j < lower.length && lower.charAt(j) == "=") {
      j++;
      while (j < lower.length && isWs(lower.charCodeAt(j))) j++;
      const q = j < lower.length ? tag.charAt(j) : "";
      if (q == "\"" || q == "'") {
        const end = tag.indexOf(q, j + 1);
        return end < 0 ? tag.slice(j + 1) : tag.slice(j + 1, end);
      }
      let e = j;
      while (e < tag.length && !isWs(tag.charCodeAt(e))) e++;
      return tag.slice(j, e);
    }
    i = at + k.length;
  }
  return "";
}

/** Code point to string (surrogate pair above the BMP). */
function codePointStr(cp: i32): string {
  if (cp < 1 || cp > 0x10ffff) return "";
  if (cp <= 0xffff) return String.fromCharCode(cp);
  const v = cp - 0x10000;
  return String.fromCharCode(0xd800 + (v >> 10)) + String.fromCharCode(0xdc00 + (v & 0x3ff));
}

function parseNumber(s: string, hex: bool): i32 {
  let v: i32 = 0;
  if (s.length == 0 || s.length > 8) return -1;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let d = -1;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (hex && c >= 97 && c <= 102) d = c - 87;
    else if (hex && c >= 65 && c <= 70) d = c - 55;
    if (d < 0) return -1;
    v = v * (hex ? 16 : 10) + d;
    if (v > 0x10ffff) return -1;
  }
  return v;
}

/** XML entity decode: the five basics plus numeric refs; unknown dropped. */
function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (c != "&") {
      out += c;
      i++;
      continue;
    }
    const semi = s.indexOf(";", i + 1);
    if (semi < 0 || semi - i > 12) {
      out += c; // stray '&'
      i++;
      continue;
    }
    const ent = s.slice(i + 1, semi);
    if (ent == "amp") out += "&";
    else if (ent == "lt") out += "<";
    else if (ent == "gt") out += ">";
    else if (ent == "quot") out += "\"";
    else if (ent == "apos") out += "'";
    else if (ent.startsWith("#")) {
      const num = ent.slice(1);
      const hex = num.startsWith("x") || num.startsWith("X");
      const v = parseNumber(hex ? num.slice(1) : num, hex);
      if (v > 0) out += codePointStr(v);
    } // unknown named entity: dropped
    i = semi + 1;
  }
  return out;
}

function setField(server: XmlServer, field: string, value: string, append: bool): void {
  if (field == "hostname") server.hostname = append ? server.hostname + value : value;
  else if (field == "port") server.port = append ? server.port + value : value;
  else if (field == "sockettype") server.socketType = append ? server.socketType + value : value;
  else if (field == "authentication" || field == "authmethod") {
    server.auth = append ? server.auth + value : value;
  } else if (field == "username") server.username = append ? server.username + value : value;
}

/** Pop the stack through `name` (tolerant of mismatched closes). */
function popTo(stack: string[], name: string): void {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i] == name) {
      stack.length = i; // truncate through i
      return;
    }
  }
  // unknown close tag: ignore
}

/**
 * Parse an ISPDB (or ISPDB-shaped) XML document into server records.
 * Best-effort and total: malformed regions are skipped, truncated tails
 * still yield whatever was parsed.
 */
export function parseIspdbXml(xml: string): XmlServer[] {
  const servers: XmlServer[] = [];
  const stack: string[] = [];
  let cur: XmlServer | null = null;
  let lastField: string = "";
  let i = 0;
  const n = xml.length;

  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break; // trailing text outside any element
    if (lt > i && cur != null && stack.length > 0) {
      const field = stack[stack.length - 1];
      const value = decodeEntities(xml.slice(i, lt));
      setField(cur, field, value, field == lastField);
      lastField = field;
    }

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) break;
      if (cur != null && stack.length > 0) {
        const field = stack[stack.length - 1];
        setField(cur, field, xml.slice(lt + 9, end), field == lastField);
        lastField = field;
      }
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      // DOCTYPE / declaration: skip past '>' with internal-subset depth
      let j = lt + 2;
      let depth = 0;
      while (j < n) {
        const ch = xml.charAt(j);
        if (ch == "[") depth++;
        else if (ch == "]") depth--;
        else if (ch == ">" && depth == 0) break;
        j++;
      }
      if (j >= n) break;
      i = j + 1;
      continue;
    }

    const gt = xml.indexOf(">", lt + 1);
    if (gt < 0) break; // unterminated tag: stop (truncated/garbage input)
    const raw = xml.slice(lt + 1, gt);
    i = gt + 1;

    if (raw.startsWith("/")) {
      const name = readName(raw);
      if (name == "incomingserver" || name == "outgoingserver") {
        if (cur != null) {
          servers.push(cur);
          cur = null;
          lastField = "";
        }
      }
      if (name.length > 0) popTo(stack, name);
      continue;
    }

    const name = readName(raw);
    if (name.length == 0) continue; // `<>`: skip
    let end = raw.length;
    while (end > 0 && isWs(raw.charCodeAt(end - 1))) end--;
    const selfClose = end > 0 && raw.charCodeAt(end - 1) == 47;
    if (name == "incomingserver" || name == "outgoingserver") {
      if (cur != null) servers.push(cur); // nested/hostile: keep both
      let type = attr(raw, "type").toLowerCase();
      if (type.length == 0) type = name == "incomingserver" ? "imap" : "smtp";
      cur = new XmlServer(type);
      lastField = "";
    }
    stack.push(name);
    if (selfClose) {
      if (name == "incomingserver" || name == "outgoingserver") {
        if (cur != null) {
          servers.push(cur);
          cur = null;
          lastField = "";
        }
      }
      popTo(stack, name);
    }
  }

  if (cur != null) servers.push(cur); // truncated tail still counts
  return servers;
}

/** Parsed servers as JSON (test/diagnostic surface). */
export function serversToJson(servers: XmlServer[]): Json {
  const out = Json.emptyArr();
  for (let i = 0; i < servers.length; i++) {
    const s = servers[i];
    const j = Json.emptyObj();
    j.setStr("type", s.type);
    j.setStr("hostname", s.hostname);
    j.setStr("port", s.port);
    j.setStr("socketType", s.socketType);
    j.setStr("auth", s.auth);
    j.setStr("username", s.username);
    out.push(j);
  }
  return out;
}
