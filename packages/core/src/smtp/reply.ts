// SMTP reply framing (RFC 5321 §4.2): incremental line buffering over
// partial feeds; a reply is complete when a line carries the final
// "NNN " form (multiline replies use "NNN-" until the last line).
// Same partial-feed contract as the IMAP reader: feeding one byte at a
// time parses identically.

export class SmtpReply {
  code: i32 = 0; // 3-digit reply code (0 = malformed)
  lines: string[] = []; // text lines without the code prefix
  text: string = ""; // lines joined with "\n"
  enhanced: string = ""; // enhanced status code when present ("5.7.1")

  isPositive(): bool {
    return this.code >= 200 && this.code < 300;
  }
}

const CR: i32 = 13;
const LF: i32 = 10;

/** Streaming SMTP reply splitter. */
export class SmtpReplyReader {
  private buf: string = ""; // byte-per-char accumulation
  private pending: SmtpReply | null = null;

  feed(chunk: Uint8Array): void {
    for (let i = 0; i < chunk.length; i++) this.buf += String.fromCharCode(chunk[i]);
  }

  /** Next complete reply, or null when more bytes are needed. */
  next(): SmtpReply | null {
    while (true) {
      const idx = this.buf.indexOf("\r\n");
      if (idx < 0) return null;
      const line = this.buf.substring(0, idx);
      this.buf = this.buf.substring(idx + 2);
      if (this.pending == null) this.pending = new SmtpReply();
      const reply = this.pending!;
      if (line.length >= 3) {
        const c0 = line.charCodeAt(0);
        const c1 = line.charCodeAt(1);
        const c2 = line.charCodeAt(2);
        if (c0 >= 48 && c0 <= 57 && c1 >= 48 && c1 <= 57 && c2 >= 48 && c2 <= 57) {
          if (reply.code == 0) reply.code = (c0 - 48) * 100 + (c1 - 48) * 10 + (c2 - 48);
          let rest = line.length > 3 ? line.substring(4) : ""; // skip "NNN " or "NNN-"
          if (line.length == 3) rest = "";
          else if (line.length > 3 && (line.charCodeAt(3) == 32 || line.charCodeAt(3) == 45)) {
            rest = line.substring(4);
          } else {
            rest = line.substring(3); // tolerate missing separator
          }
          if (reply.lines.length == 0 && rest.length > 0) extractEnhanced(reply, rest);
          reply.lines.push(rest);
          const final = line.length < 4 || line.charCodeAt(3) == 32;
          if (final) {
            let text = "";
            for (let i = 0; i < reply.lines.length; i++) {
              if (i > 0) text += "\n";
              text += reply.lines[i];
            }
            reply.text = text;
            this.pending = null;
            return reply;
          }
          continue; // multiline: keep buffering
        }
      }
      // Malformed line inside a reply: fold it in so callers still see it,
      // and complete the reply if it already had a code (never hang).
      if (reply.code != 0) {
        reply.lines.push(line);
        let text = "";
        for (let i = 0; i < reply.lines.length; i++) {
          if (i > 0) text += "\n";
          text += reply.lines[i];
        }
        reply.text = text;
        this.pending = null;
        return reply;
      }
      // leading garbage before any code: drop the line (servers may emit
      // banner noise); keep waiting for a well-formed reply line.
    }
  }
}

/** Pull "5.7.1"-style enhanced codes off the first text line. */
function extractEnhanced(reply: SmtpReply, rest: string): void {
  let i = 0;
  while (i < rest.length && rest.charCodeAt(i) == 32) i++;
  let digits = 0;
  let seen = "";
  let j = i;
  while (j < rest.length) {
    const c = rest.charCodeAt(j);
    if (c >= 48 && c <= 57 && (seen.length == 0 || seen.charCodeAt(seen.length - 1) == 46)) {
      seen += rest.charAt(j);
      digits++;
      j++;
      if (j < rest.length && rest.charCodeAt(j) == 46 && digits <= 3) {
        seen += ".";
        j++;
        continue;
      }
      break;
    }
    break;
  }
  // valid enhanced code: 2-3 dot-separated digit groups (e.g. 5.7.1)
  if (seen.length > 0 && seen.charCodeAt(seen.length - 1) != 46) {
    let dots = 0;
    for (let k = 0; k < seen.length; k++) if (seen.charCodeAt(k) == 46) dots++;
    if (dots == 2) reply.enhanced = seen;
  }
}
