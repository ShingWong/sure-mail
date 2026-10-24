// Strict JSON parser (RFC 8259 grammar, no extensions): whitespace allowed
// around values, control characters rejected in strings, trailing content
// rejected, nesting depth limited. Returns null on any error — AS has no
// exceptions, and null keeps error handling in the caller's hands.

import { Json } from "./value.ts";

const MAX_DEPTH: i32 = 64;

// 10^k is exact in f64 for k <= 22; beyond that pow10 chains exact
// chunks (the result is inexact, but only extreme exponents get here).
const POW10: f64[] = [
  1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11,
  1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22,
];

function pow10(k: i32): f64 {
  if (k <= 22) return k >= 0 ? POW10[k] : 1.0;
  if (k > 308) return Infinity;
  let v = POW10[22];
  let remaining = k - 22;
  while (remaining > 0) {
    v *= POW10[remaining > 22 ? 22 : remaining];
    remaining -= 22;
  }
  return v;
}

class Parser {
  text: string;
  pos: i32 = 0;
  depth: i32 = 0;

  constructor(text: string) {
    this.text = text;
  }

  atEnd(): bool {
    return this.pos >= this.text.length;
  }

  peek(): i32 {
    if (this.atEnd()) return -1;
    return this.text.charCodeAt(this.pos);
  }

  skipWs(): void {
    while (!this.atEnd()) {
      const c = this.text.charCodeAt(this.pos);
      if (c == 32 || c == 9 || c == 10 || c == 13) this.pos++;
      else break;
    }
  }

  parseValue(): Json | null {
    this.skipWs();
    const c = this.peek();
    if (c == 123) return this.parseObject(); // {
    if (c == 91) return this.parseArray(); // [
    if (c == 34) return this.parseString(); // "
    if (c == 116) return this.parseKeyword("true", Json.ofBool(true)); // t
    if (c == 102) return this.parseKeyword("false", Json.ofBool(false)); // f
    if (c == 110) return this.parseKeyword("null", Json.nil()); // n
    if (c == 45 || (c >= 48 && c <= 57)) return this.parseNumber(); // - 0-9
    return null;
  }

  parseKeyword(word: string, value: Json): Json | null {
    if (this.text.startsWith(word, this.pos)) {
      this.pos += word.length;
      return value;
    }
    return null;
  }

  parseNumber(): Json | null {
    const start = this.pos;
    if (this.peek() == 45) this.pos++;
    const c0 = this.peek();
    if (c0 == 48) {
      this.pos++; // single zero
    } else if (c0 >= 49 && c0 <= 57) {
      while (!this.atEnd()) {
        const c = this.text.charCodeAt(this.pos);
        if (c >= 48 && c <= 57) this.pos++;
        else break;
      }
    } else {
      return null;
    }
    if (this.peek() == 46) {
      this.pos++;
      const fdigStart = this.pos;
      while (!this.atEnd()) {
        const c = this.text.charCodeAt(this.pos);
        if (c >= 48 && c <= 57) this.pos++;
        else break;
      }
      if (this.pos == fdigStart) return null;
    }
    let expPart = 0;
    let expNeg = false;
    if (!this.atEnd()) {
      const c = this.peek();
      if (c == 101 || c == 69) {
        this.pos++;
        if (this.peek() == 43) this.pos++;
        else if (this.peek() == 45) {
          expNeg = true;
          this.pos++;
        }
        const edigStart = this.pos;
        while (!this.atEnd()) {
          const d = this.text.charCodeAt(this.pos);
          if (d >= 48 && d <= 57) {
            if (expPart < 999) expPart = expPart * 10 + (d - 48);
            this.pos++;
          } else break;
        }
        if (this.pos == edigStart) return null;
      }
    }
    const n = this.assembleNumber(start, this.pos, expPart, expNeg);
    if (isNaN(n) || n == Infinity || n == -Infinity) return null;
    return Json.ofNum(n);
  }

  // Assemble the literal [start..end) into an f64 that matches the
  // correctly-rounded value for typical inputs: the mantissa digits are
  // accumulated exactly (up to 2^53), then scaled with one IEEE division
  // (or multiplication) by an exact power of ten.
  private assembleNumber(start: i32, end: i32, expPart: i32, expNeg: bool): f64 {
    let i = start;
    let neg = false;
    if (this.text.charCodeAt(i) == 45) {
      neg = true;
      i++;
    }
    let m: f64 = 0;
    let fracDigits = 0;
    let inFraction = false;
    while (i < end) {
      const c = this.text.charCodeAt(i);
      if (c == 46) {
        inFraction = true;
      } else if (c >= 48 && c <= 57) {
        m = m * 10.0 + <f64>(c - 48);
        if (inFraction) fracDigits++;
      } else {
        break; // 'e'/'E' + exponent are handled via expPart
      }
      i++;
    }
    // value = m * 10^(±expPart - fracDigits)
    const eff = (expNeg ? -expPart : expPart) - fracDigits;
    let value = m;
    if (eff < 0) value = m / pow10(-eff);
    else if (eff > 0) value = m * pow10(eff);
    return neg ? -value : value;
  }

  parseString(): Json | null {
    if (this.peek() != 34) return null;
    this.pos++;
    const out: string[] = [];
    let chunkStart = this.pos;
    while (!this.atEnd()) {
      const c = this.text.charCodeAt(this.pos);
      if (c == 34) {
        if (this.pos > chunkStart) out.push(this.text.slice(chunkStart, this.pos));
        this.pos++;
        return Json.ofStr(out.join(""));
      }
      if (c < 32) return null; // unescaped control character
      if (c == 92) { // backslash escape
        if (this.pos > chunkStart) out.push(this.text.slice(chunkStart, this.pos));
        this.pos++;
        if (this.atEnd()) return null;
        const e = this.text.charCodeAt(this.pos);
        if (e == 34) out.push("\"");
        else if (e == 92) out.push("\\");
        else if (e == 47) out.push("/");
        else if (e == 98) out.push("\u{0008}");
        else if (e == 102) out.push("\u{000C}");
        else if (e == 110) out.push("\n");
        else if (e == 114) out.push("\r");
        else if (e == 116) out.push("\t");
        else if (e == 117) {
          const unit = this.parseHex4();
          if (unit < 0) return null;
          out.push(String.fromCharCode(unit));
        } else {
          return null;
        }
        this.pos++;
        chunkStart = this.pos;
      } else {
        this.pos++;
      }
    }
    return null; // unterminated string
  }

  private parseHex4(): i32 {
    if (this.pos + 4 >= this.text.length) return -1;
    let v: i32 = 0;
    for (let k = 1; k <= 4; k++) {
      const c = this.text.charCodeAt(this.pos + k);
      v <<= 4;
      if (c >= 48 && c <= 57) v |= c - 48;
      else if (c >= 97 && c <= 102) v |= c - 87;
      else if (c >= 65 && c <= 70) v |= c - 55;
      else return -1;
    }
    this.pos += 4;
    return v;
  }

  parseArray(): Json | null {
    this.pos++; // [
    this.depth++;
    if (this.depth > MAX_DEPTH) return null;
    const arr = Json.emptyArr();
    this.skipWs();
    if (this.peek() == 93) {
      this.pos++;
      this.depth--;
      return arr;
    }
    for (;;) {
      const v = this.parseValue();
      if (v == null) return null;
      arr.push(v);
      this.skipWs();
      const c = this.peek();
      if (c == 44) {
        this.pos++;
        continue;
      }
      if (c == 93) {
        this.pos++;
        this.depth--;
        return arr;
      }
      return null;
    }
  }

  parseObject(): Json | null {
    this.pos++; // {
    this.depth++;
    if (this.depth > MAX_DEPTH) return null;
    const obj = Json.emptyObj();
    this.skipWs();
    if (this.peek() == 125) {
      this.pos++;
      this.depth--;
      return obj;
    }
    for (;;) {
      this.skipWs();
      if (this.peek() != 34) return null;
      const key = this.parseString();
      if (key == null) return null;
      const keyStr = key.strVal;
      if (keyStr == null) return null;
      this.skipWs();
      if (this.peek() != 58) return null;
      this.pos++;
      const v = this.parseValue();
      if (v == null) return null;
      obj.set(keyStr, v);
      this.skipWs();
      const c = this.peek();
      if (c == 44) {
        this.pos++;
        continue;
      }
      if (c == 125) {
        this.pos++;
        this.depth--;
        return obj;
      }
      return null;
    }
  }
}

export function parseJson(text: string): Json | null {
  const p = new Parser(text);
  const v = p.parseValue();
  if (v == null) return null;
  p.skipWs();
  if (!p.atEnd()) return null;
  return v;
}
