// Incremental IMAP response framing: bytes in, complete responses out.
// Handles {n} literals (including split across feeds) — a response ends
// at CRLF *outside* literal content. Partial feeds are the normal case:
// every field buffers until complete, so feeding one byte at a time
// parses identically (fuzz-tested).

export const SEG_TEXT: i8 = 0;
export const SEG_LITERAL: i8 = 1;

/** One piece of a response: protocol text or literal bytes. */
export class Segment {
  kind: i8 = SEG_TEXT;
  text: string = ""; // SEG_TEXT: byte-per-char
  bytes: Uint8Array | null = null; // SEG_LITERAL

  static text_(s: string): Segment {
    const seg = new Segment();
    seg.kind = SEG_TEXT;
    seg.text = s;
    return seg;
  }

  static literal(b: Uint8Array): Segment {
    const seg = new Segment();
    seg.kind = SEG_LITERAL;
    seg.bytes = b;
    seg.text = latin1(b);
    return seg;
  }
}

/** Bytes as one char per byte (protocol text is ASCII; names opaque). */
export function latin1(b: Uint8Array): string {
  const codes: i32[] = new Array<i32>(b.length);
  for (let i = 0; i < b.length; i++) codes[i] = b[i];
  return String.fromCharCodes(codes);
}

/** Reverse: char-per-byte string back to bytes. */
export function unlatain(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = <u8>(s.charCodeAt(i) & 0xff);
  return out;
}

/** A complete response: an ordered list of segments. */
export class RawResponse {
  segments: Segment[] = [];

  push(seg: Segment): void {
    this.segments.push(seg);
  }

  /** Concatenated text with literals rendered byte-per-char. */
  fullText(): string {
    let out = "";
    for (let i = 0; i < this.segments.length; i++) {
      out += this.segments[i].text;
    }
    return out;
  }

  /** First literal's bytes (FETCH payloads), or null. */
  firstLiteral(): Uint8Array | null {
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      if (seg.kind == SEG_LITERAL && seg.bytes != null) return seg.bytes;
    }
    return null;
  }

  hasLiteral(): bool {
    for (let i = 0; i < this.segments.length; i++) {
      if (this.segments[i].kind == SEG_LITERAL) return true;
    }
    return false;
  }
}

const CR: u8 = 13;
const LF: u8 = 10;

/**
 * Streaming response splitter. feed() buffers bytes; next() returns the
 * next complete response or null if more bytes are needed.
 */
export class ResponseReader {
  private buf: Uint8Array = new Uint8Array(8192);
  private start: i32 = 0;
  private end: i32 = 0;
  private literalRemaining: i32 = 0;
  private pending: RawResponse | null = null;
  private literalAcc: Uint8Array | null = null;
  private literalAccLen: i32 = 0;

  feed(chunk: Uint8Array): void {
    this.ensure(this.end - this.start + chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      this.buf[this.end++] = chunk[i];
    }
  }

  private ensure(extra: i32): void {
    const used = this.end - this.start;
    if (this.buf.length - used >= extra) {
      if (this.start > 0) {
        for (let i = 0; i < used; i++) this.buf[i] = this.buf[this.start + i];
        this.end -= this.start;
        this.start = 0;
      }
      return;
    }
    let size = this.buf.length;
    while (size - used < extra) size *= 2;
    const next = new Uint8Array(size);
    for (let i = 0; i < used; i++) next[i] = this.buf[this.start + i];
    this.end -= this.start;
    this.start = 0;
    this.buf = next;
  }

  private available(): i32 {
    return this.end - this.start;
  }

  /** Next complete response, or null when more bytes are needed. */
  next(): RawResponse | null {
    if (this.pending == null) this.pending = new RawResponse();
    const resp = this.pending!;
    for (;;) {
      if (this.literalRemaining > 0) {
        if (this.available() == 0) return null;
        const take = this.literalRemaining < this.available() ? this.literalRemaining : this.available();
        let acc = this.literalAcc;
        if (acc == null || acc.length < this.literalRemaining) {
          const fresh = new Uint8Array(this.literalRemaining);
          if (acc != null) {
            for (let i = 0; i < this.literalAccLen; i++) fresh[i] = acc[i];
          }
          acc = fresh;
          this.literalAcc = acc;
          this.literalAccLen = 0;
        }
        for (let i = 0; i < take; i++) {
          acc[this.literalAccLen++] = this.buf[this.start + i];
        }
        this.start += take;
        this.literalRemaining -= take;
        if (this.literalRemaining == 0) {
          resp.push(Segment.literal(acc.slice(0, this.literalAccLen)));
          this.literalAcc = null;
          this.literalAccLen = 0;
        }
        continue;
      }
      // Scan for CRLF in buffered bytes.
      const scanEnd = this.end - 1; // need room for CR
      let lineEnd = -1; // index of CR
      for (let i = this.start; i < scanEnd; i++) {
        if (this.buf[i] == CR && this.buf[i + 1] == LF) {
          lineEnd = i;
          break;
        }
      }
      if (lineEnd < 0) return null; // incomplete line
      const markerStart = literalMarkerStart(this.buf, this.start, lineEnd);
      const line = this.buf.slice(this.start, lineEnd);
      this.start = lineEnd + 2;
      if (markerStart >= 0) {
        // Strip the `{n}`/`{n+}` marker: the literal bytes follow inline
        // and the response continues after them.
        this.literalRemaining = literalMarkerSize(this.buf, markerStart, lineEnd);
        resp.push(Segment.text_(latin1(line.slice(0, markerStart - (lineEnd - line.length)))));
        continue; // response continues after the literal
      }
      resp.push(Segment.text_(latin1(line)));
      this.pending = null;
      return resp;
    }
  }
}

/**
 * If bytes [from..to) end with an IMAP literal marker, return the index
 * of its opening `{`; otherwise -1.
 */
function literalMarkerStart(buf: Uint8Array, from: i32, to: i32): i32 {
  let i = to - 1;
  if (i < from || buf[i] != 125) return -1; // '}'
  i--;
  if (i >= from && buf[i] == 43) i--; // LITERAL+ '+'
  while (i >= from && buf[i] >= 48 && buf[i] <= 57) i--;
  if (i < from || buf[i] != 123) return -1; // '{'
  return i;
}

/** Parse the digit run of a marker whose `{` is at `from`. */
function literalMarkerSize(buf: Uint8Array, from: i32, to: i32): i32 {
  let i = to - 1;
  if (i > from && buf[i] == 43) i--; // '+'
  if (i > from && buf[i] == 125) i--; // '}'
  let n = 0;
  let scale = 1;
  while (i > from && buf[i] >= 48 && buf[i] <= 57) {
    n += (buf[i] - 48) * scale;
    scale *= 10;
    i--;
  }
  return n;
}
