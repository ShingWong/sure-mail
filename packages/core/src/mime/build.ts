// MIME builder (M3): assembles an RFC 5322 raw
// message from a JSON spec — multipart/mixed + multipart/alternative,
// base64 attachments with RFC 2231 filenames, quoted-printable bodies,
// RFC 2047 header words, Message-ID/Date/MIME-Version. Also the
// reply/forward helpers: In-Reply-To/References chaining, ">"-quoted
// bodies, idempotent Re:/Fwd: subjects. Pure: the only host contact is
// the clock/random ports via encode.ts (Message-ID/Date defaults).

import { Json, KIND_ARR } from "../json/value.ts";
import { b64Decode } from "../encoding/base64.ts";
import {
  base64Wrapped,
  encodeHeaderWord,
  formatAddressList,
  formatRfc5322,
  generateMessageId,
  qpEncodeText,
  rfc2231Param,
} from "./encode.ts";

export const MAX_TEXT_BYTES: i32 = 1024 * 1024; // 1 MiB text cap (guard)
export const MAX_ATTACH_BYTES: i32 = 25 * 1024 * 1024; // 25 MiB per attachment

/** What buildMessage received, normalized. Non-null result = ready. */
export class BuildPlan {
  ok: bool = false;
  error: string = "";
  raw: string = ""; // byte-per-char CRLF message text
  boundaryMixed: string = "";
  boundaryAlt: string = "";
}

function crlf(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c == 13) {
      if (i + 1 < s.length && s.charCodeAt(i + 1) == 10) i++;
      out += "\r\n";
    } else if (c == 10) out += "\r\n";
    else out += s.charAt(i);
  }
  return out;
}

/** ASCII-only and no bare CR/LF surprises: safe as a 7bit body. */
function isPlainAscii(s: string): bool {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 126 || (c < 32 && c != 9 && c != 10 && c != 13)) return false;
  }
  return true;
}

class EncodedBody {
  text: string = "";
  encoding: string = "7bit";
}

class Attachment {
  headers: string[] = [];
  body: string = "";
}

/** Body part encoding: 7bit for plain ASCII, quoted-printable otherwise. */
function encodeBody(text: string): EncodedBody {
  const out = new EncodedBody();
  if (isPlainAscii(text)) {
    out.text = crlf(text);
    out.encoding = "7bit";
  } else {
    out.text = qpEncodeText(text);
    out.encoding = "quoted-printable";
  }
  return out;
}

// -- header assembly ---------------------------------------------------------

class HeaderList {
  lines: string[] = [];

  add(name: string, value: string): void {
    if (value.length == 0) return;
    this.lines.push(name + ": " + value);
  }

  addEncoded(name: string, value: string): void {
    if (value.length == 0) return;
    this.lines.push(name + ": " + encodeHeaderWord(value));
  }

  block(): string {
    return this.lines.join("\r\n");
  }
}

function addressHeader(addrs: Json | null): string {
  if (addrs == null || addrs.kind != KIND_ARR) return "";
  const filtered = Json.emptyArr();
  for (let i = 0; i < addrs.length; i++) {
    const a = addrs.at(i);
    if (a == null) continue;
    const address = a.getString("address", "");
    if (address.length > 0) filtered.push(a);
  }
  return formatAddressList(filtered);
}

function addrStrings(addrs: Json): string[] {
  const out: string[] = [];
  if (addrs.kind != KIND_ARR) return out;
  for (let i = 0; i < addrs.length; i++) {
    const a = addrs.at(i);
    if (a == null) continue;
    const address = a.getString("address", "");
    if (address.length > 0) out.push(address);
  }
  return out;
}

/** Envelope recipient list: to + cc + bcc (deduped, order kept). */
export function envelopeRecipients(message: Json): string[] {
  const out: string[] = [];
  const lists = ["to", "cc", "bcc"];
  for (let li = 0; li < lists.length; li++) {
    const arr = message.get(lists[li]);
    if (arr == null) continue;
    const addrs = addrStrings(arr);
    for (let i = 0; i < addrs.length; i++) {
      let seen = false;
      for (let j = 0; j < out.length; j++) {
        if (out[j].toLowerCase() == addrs[i].toLowerCase()) seen = true;
      }
      if (!seen) out.push(addrs[i]);
    }
  }
  return out;
}

// -- subjects (Re:/Fwd: idempotent) ------------------------------------------

/** Ensure a "Re: " prefix (idempotent, tolerates existing re/fw prefixes). */
export function replySubject(subject: string): string {
  const low = subject.toLowerCase();
  if (low.startsWith("re:")) return subject;
  if (low.startsWith("fwd:") || low.startsWith("fw:")) return "Re: " + subject;
  return "Re: " + subject;
}

/** Ensure a "Fwd: " prefix (idempotent). */
export function forwardSubject(subject: string): string {
  const low = subject.toLowerCase();
  if (low.startsWith("fwd:")) return subject;
  if (low.startsWith("re:")) return "Fwd: " + subject.substring(subject.indexOf(":") + 1).trim();
  return "Fwd: " + subject;
}

/**
 * Quote a body for a reply: every line gets a "> " prefix (nested levels
 * accumulate when quoting quoted text — just add more ">").
 */
export function quoteBody(text: string): string {
  const lines = crlf(text).split("\r\n");
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    out += lines[i].length > 0 ? "> " + lines[i] : ">";
    if (i + 1 < lines.length) out += "\r\n";
  }
  return out;
}

/**
 * "On <date>, <who> wrote:" attribution for replies — only when the
 * referenced message supplied both; returns "" otherwise.
 */
export function replyAttribution(date: string, who: string): string {
  if (date.length == 0 || who.length == 0) return "";
  return "On " + date + ", " + who + " wrote:";
}

// -- the builder -------------------------------------------------------------

function attachmentPart(att: Json): Attachment | null {
  const filename = att.getString("filename", "");
  const contentType = att.getString("contentType", "application/octet-stream");
  const dataB64 = att.getString("dataB64", "");
  const bytes = b64Decode(dataB64);
  if (bytes == null) return null;
  if (bytes.length > MAX_ATTACH_BYTES) return null;
  const out = new Attachment();
  let ct = "Content-Type: " + contentType;
  if (filename.length > 0) ct += "; " + rfc2231Param("name", filename);
  out.headers.push(ct);
  let disp = "Content-Disposition: attachment";
  if (filename.length > 0) disp += "; " + rfc2231Param("filename", filename);
  out.headers.push(disp);
  out.headers.push("Content-Transfer-Encoding: base64");
  out.body = base64Wrapped(bytes);
  return out;
}

function textPartHeaders(subtype: string, encoding: string): string[] {
  const headers: string[] = [];
  headers.push("Content-Type: text/" + subtype + "; charset=utf-8");
  headers.push("Content-Transfer-Encoding: " + encoding);
  return headers;
}

/**
 * Build a raw message from the `message` JSON:
 *   {from:{name?,address}, to:[{name?,address}], cc?, bcc?, subject?,
 *    text?, html?, attachments?:[{filename,contentType?,dataB64}],
 *    date?:<rfc5322 string>, messageId?:<string>,
 *    replyTo?:{subject,from,date,messageId,bodyText,references?}}
 * replyTo (from a stored message) triggers reply chaining: subject gets
 * "Re: " (idempotent), In-Reply-To/References are set, and the original
 * body is ">"-quoted beneath the new text.
 */
export function buildMessage(message: Json): BuildPlan {
  const plan = new BuildPlan();
  const from = message.get("from");
  const fromAddress = from != null ? from.getString("address", "") : "";
  if (fromAddress.length == 0 || fromAddress.indexOf("@") < 0) {
    plan.error = "from.address required";
    return plan;
  }
  const to = message.get("to");
  const recipients = envelopeRecipients(message);
  if (recipients.length == 0) {
    plan.error = "at least one recipient required";
    return plan;
  }

  const attachments = message.get("attachments");
  const attList: Json[] = [];
  if (attachments != null && attachments.kind == KIND_ARR) {
    for (let i = 0; i < attachments.length; i++) {
      const a = attachments.at(i);
      if (a != null) attList.push(a);
    }
  }

  // reply / forward chain ----------------------------------------------------
  const reply = message.get("replyTo");
  const forward = message.get("forwardTo");
  let subject = message.getString("subject", "");
  // Drafts persist the chain headers directly; live reply/forward builds
  // them from the referenced message below (which wins when both appear).
  let inReplyTo = message.getString("inReplyTo", "");
  let references = message.getString("references", "");
  let quotedText = "";
  let attribution = "";
  let forwardedBlock = "";
  if (reply != null && reply.kind == 5 /* KIND_OBJ */) {
    const origSubject = reply.getString("subject", "");
    subject = replySubject(origSubject.length > 0 ? origSubject : subject);
    inReplyTo = reply.getString("messageId", "");
    const origRefs = reply.getString("references", "");
    if (origRefs.length > 0) references = origRefs;
    if (inReplyTo.length > 0) {
      references = references.length > 0 ? references + " " + inReplyTo : inReplyTo;
    }    const origBody = reply.getString("bodyText", "");
    const origFrom = reply.getString("from", "");
    const origDate = reply.getString("date", "");
    if (origBody.length > 0) {
      attribution = replyAttribution(origDate, origFrom);
      quotedText = quoteBody(origBody);
    }
  } else if (forward != null && forward.kind == 5 /* KIND_OBJ */) {
    const origSubject = forward.getString("subject", "");
    subject = forwardSubject(origSubject.length > 0 ? origSubject : subject);
    // classic forward header block; no In-Reply-To (forwards don't thread)
    forwardedBlock =
      "---------- Forwarded message ----------\r\n" +
      "From: " + forward.getString("from", "") + "\r\n" +
      "Date: " + forward.getString("date", "") + "\r\n" +
      "Subject: " + forward.getString("subject", "") + "\r\n" +
      "To: " + forward.getString("to", "") + "\r\n\r\n";
    quotedText = quoteBody(forward.getString("bodyText", ""));
  }

  // bodies ------------------------------------------------------------------
  let text = crlf(message.getString("text", ""));
  const htmlRaw = message.getString("html", "");
  const html = crlf(htmlRaw);
  if (forwardedBlock.length > 0) {
    const sep = text.length > 0 ? "\r\n" : "";
    text = text + sep + crlf(forwardedBlock) + quotedText + "\r\n";
  } else if (quotedText.length > 0) {
    const sep = text.length > 0 ? "\r\n" : "";
    const attr = attribution.length > 0 ? attribution + "\r\n\r\n" : "";
    text = text + sep + attr + quotedText + "\r\n";
  }
  if (text.length > MAX_TEXT_BYTES || html.length > MAX_TEXT_BYTES) {
    plan.error = "body too large";
    return plan;
  }

  const hasText = text.trim().length > 0;
  const hasHtml = html.trim().length > 0;
  if (!hasText && !hasHtml && attList.length == 0) {
    plan.error = "message is empty (text, html, or attachments required)";
    return plan;
  }

  // deterministic boundaries: derived from the message id
  const messageId = message.getString("messageId", "");
  const domain = fromAddress.substring(fromAddress.indexOf("@") + 1);
  const id = messageId.length > 0 ? messageId : generateMessageId(domain);
  let idSeed = "";
  for (let i = 0; i < id.length && idSeed.length < 16; i++) {
    const c = id.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 97 && c <= 122)) idSeed += id.charAt(i);
  }
  if (idSeed.length == 0) idSeed = "0";
  const boundaryMixed = "----=_Part_" + idSeed + "_mixed";
  const boundaryAlt = "----=_Part_" + idSeed + "_alt";

  // structure: mixed[ alt[text, html] | single text ] + attachments
  const bodySections: string[][] = []; // each section: header lines
  const bodyBodies: string[] = [];
  const useMixed = attList.length > 0;
  const useAlt = hasText && hasHtml;

  if (useAlt) {
    const t = encodeBody(text);
    bodySections.push(textPartHeaders("plain", t.encoding));
    bodyBodies.push(t.text);
    const h = encodeBody(html);
    bodySections.push(textPartHeaders("html", h.encoding));
    bodyBodies.push(h.text);
  } else if (hasText) {
    const t = encodeBody(text);
    bodySections.push(textPartHeaders("plain", t.encoding));
    bodyBodies.push(t.text);
  } else {
    const h = encodeBody(html);
    bodySections.push(textPartHeaders("html", h.encoding));
    bodyBodies.push(h.text);
  }

  // headers -----------------------------------------------------------------
  const headers = new HeaderList();
  headers.add("From", formatAddressOrBare(message.get("from")));
  headers.add("To", addressHeader(message.get("to")));
  headers.add("Cc", addressHeader(message.get("cc")));
  headers.addEncoded("Subject", subject);
  headers.add("Date", message.getString("date", "").length > 0 ? message.getString("date", "") : formatRfc5322(NaN));
  headers.add("Message-ID", id.startsWith("<") ? id : "<" + id + ">");
  if (inReplyTo.length > 0) headers.add("In-Reply-To", inReplyTo.startsWith("<") ? inReplyTo : "<" + inReplyTo + ">");
  if (references.trim().length > 0) headers.add("References", references.trim());

  // assembly ----------------------------------------------------------------
  let raw = headers.block() + "\r\n";
  raw += "MIME-Version: 1.0\r\n";

  if (useMixed) {
    raw += 'Content-Type: multipart/mixed; boundary="' + boundaryMixed + '"\r\n\r\n';
    if (useAlt) {
      raw += "--" + boundaryMixed + "\r\n";
      raw += 'Content-Type: multipart/alternative; boundary="' + boundaryAlt + '"\r\n\r\n';
      for (let i = 0; i < bodySections.length; i++) {
        raw += "--" + boundaryAlt + "\r\n";
        raw += bodySections[i].join("\r\n") + "\r\n\r\n";
        raw += bodyBodies[i] + "\r\n";
      }
      raw += "--" + boundaryAlt + "--\r\n";
    } else {
      raw += "--" + boundaryMixed + "\r\n";
      raw += bodySections[0].join("\r\n") + "\r\n\r\n";
      raw += bodyBodies[0] + "\r\n";
    }
    for (let i = 0; i < attList.length; i++) {
      const part = attachmentPart(attList[i]);
      if (part == null) {
        plan.error = "attachment " + (i + 1).toString() + " has invalid data";
        return plan;
      }
      raw += "--" + boundaryMixed + "\r\n";
      raw += part.headers.join("\r\n") + "\r\n\r\n";
      raw += part.body + "\r\n";
    }
    raw += "--" + boundaryMixed + "--\r\n";
  } else if (useAlt) {
    raw += 'Content-Type: multipart/alternative; boundary="' + boundaryAlt + '"\r\n\r\n';
    for (let i = 0; i < bodySections.length; i++) {
      raw += "--" + boundaryAlt + "\r\n";
      raw += bodySections[i].join("\r\n") + "\r\n\r\n";
      raw += bodyBodies[i] + "\r\n";
    }
    raw += "--" + boundaryAlt + "--\r\n";
  } else {
    raw += bodySections[0].join("\r\n") + "\r\n\r\n";
    raw += bodyBodies[0] + "\r\n";
  }

  plan.ok = true;
  plan.raw = raw;
  plan.boundaryMixed = useMixed ? boundaryMixed : "";
  plan.boundaryAlt = useAlt ? boundaryAlt : "";
  return plan;
}

function formatAddressOrBare(addr: Json | null): string {
  if (addr == null) return "";
  const address = addr.getString("address", "");
  const name = addr.getString("name", "");
  if (name.length == 0) return address;
  const j = Json.emptyArr();
  j.push(addr);
  return formatAddressList(j);
}
