// IMAP response tokenizer: turns a RawResponse's segments into tokens
// (parens, atoms, quoted strings, literals). Atoms include unquoted
// numbers and flags; consumers interpret them.

import { RawResponse, SEG_LITERAL, unlatain } from "./reader.ts";

export const TOK_EOF: i8 = -1;
export const TOK_LPAREN: i8 = 0;
export const TOK_RPAREN: i8 = 1;
export const TOK_ATOM: i8 = 2;
export const TOK_STRING: i8 = 3; // quoted or literal, text form
export const TOK_LITERAL: i8 = 4; // literal with raw bytes

export class Token {
  kind: i8 = TOK_EOF;
  text: string = "";
  bytes: Uint8Array | null = null; // TOK_LITERAL only
}

const SP: i32 = 32;

export class Tokenizer {
  private segs: RawResponse;
  private si: i32 = 0;
  private pos: i32 = 0;
  private peeked: Token | null = null;

  constructor(segs: RawResponse) {
    this.segs = segs;
  }

  peek(): Token {
    if (this.peeked == null) {
      this.peeked = this.next();
    }
    return this.peeked!;
  }

  next(): Token {
    if (this.peeked != null) {
      const t = this.peeked!;
      this.peeked = null;
      return t;
    }
    const tok = new Token();
    // Skip separators and fetch the next segment kind.
    for (;;) {
      while (this.si < this.segs.segments.length && this.segs.segments[this.si].kind != SEG_LITERAL) {
        const text = this.segs.segments[this.si].text;
        if (this.pos >= text.length) {
          this.si++;
          this.pos = 0;
          continue;
        }
        const c = text.charCodeAt(this.pos);
        if (c != SP && c != 9 && c != 13 && c != 10) break;
        this.pos++;
      }
      if (this.si >= this.segs.segments.length) {
        tok.kind = TOK_EOF;
        return tok;
      }
      const seg = this.segs.segments[this.si];
      if (seg.kind == SEG_LITERAL) {
        this.si++;
        this.pos = 0;
        tok.kind = TOK_LITERAL;
        tok.bytes = seg.bytes;
        tok.text = seg.text;
        return tok;
      }
      const text = seg.text;
      const c = text.charCodeAt(this.pos);
      if (c == 40) { // '('
        this.pos++;
        tok.kind = TOK_LPAREN;
        tok.text = "(";
        return tok;
      }
      if (c == 41) { // ')'
        this.pos++;
        tok.kind = TOK_RPAREN;
        tok.text = ")";
        return tok;
      }
      if (c == 34) { // '"' quoted string
        this.pos++;
        let out = "";
        let closed = false;
        while (this.si < this.segs.segments.length) {
          const s2 = this.segs.segments[this.si];
          if (s2.kind == SEG_LITERAL) break;
          const t2 = s2.text;
          while (this.pos < t2.length) {
            const q = t2.charCodeAt(this.pos);
            if (q == 92) { // backslash escape
              if (this.pos + 1 < t2.length) {
                out += t2.charAt(this.pos + 1);
                this.pos += 2;
              } else {
                this.pos++;
              }
              continue;
            }
            if (q == 34) {
              this.pos++;
              closed = true;
              break;
            }
            out += t2.charAt(this.pos);
            this.pos++;
          }
          if (closed) break;
          this.si++;
          this.pos = 0;
        }
        tok.kind = TOK_STRING;
        tok.text = out;
        return tok;
      }
      // atom: everything up to SP or parens
      let atom = "";
      while (this.pos < text.length) {
        const a = text.charCodeAt(this.pos);
        if (a == SP || a == 40 || a == 41) break;
        atom += text.charAt(this.pos);
        this.pos++;
      }
      if (atom.length == 0) {
        this.pos++; // defensive: never loop forever
        continue;
      }
      tok.kind = TOK_ATOM;
      tok.text = atom;
      return tok;
    }
  }

  /** True when only EOF remains. */
  atEnd(): bool {
    return this.peek().kind == TOK_EOF;
  }
}

/** Parse a decimal atom; returns fallback when not numeric. */
export function strInt(s: string, fallback: i32): i32 {
  if (s.length == 0) return fallback;
  let n: i64 = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return fallback;
    n = n * 10 + (c - 48);
    if (n > 2147483647) return fallback;
  }
  return <i32>n;
}

export function tokenInt(tok: Token, fallback: i32): i32 {
  return strInt(tok.text, fallback);
}

/** Parse an unsigned decimal as f64 (u32-range values need this). */
export function strNum(s: string, fallback: f64): f64 {
  if (s.length == 0) return fallback;
  let i = 0;
  let neg = false;
  if (s.charCodeAt(0) == 45) {
    neg = true;
    i = 1;
  }
  if (i >= s.length) return fallback;
  let n: f64 = 0;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return fallback;
    n = n * 10.0 + <f64>(c - 48);
  }
  return neg ? -n : n;
}

export function tokenBytes(tok: Token): Uint8Array {
  if (tok.bytes != null) return tok.bytes!;
  return unlatain(tok.text);
}
