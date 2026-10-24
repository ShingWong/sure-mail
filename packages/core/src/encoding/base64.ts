// Base64 (RFC 4648) encode/decode. Bytes cross the JSON ABI as base64
// ("b64" fields, docs/abi.md §2), so this must be exact and tested.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Decode lookup: -1 = invalid, -2 = padding, >= 0 = sextet value.
let decodeTable: Int8Array | null = null;

function getDecodeTable(): Int8Array {
  let table = decodeTable;
  if (table != null) return table;
  table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    table[ALPHABET.charCodeAt(i)] = <i8>i;
  }
  table[61] = <i8>-2; // '='
  decodeTable = table;
  return table;
}

/** Encode bytes as standard base64 with padding. */
export function b64Encode(data: Uint8Array): string {
  const n = data.length;
  const outLen = ((n + 2) / 3 | 0) * 4;
  const out = new Uint16Array(outLen);
  const table = ALPHABET;
  let o = 0;
  let i = 0;
  while (n - i >= 3) {
    const b0 = data[i];
    const b1 = data[i + 1];
    const b2 = data[i + 2];
    out[o] = table.charCodeAt(b0 >> 2);
    out[o + 1] = table.charCodeAt(((b0 & 3) << 4) | (b1 >> 4));
    out[o + 2] = table.charCodeAt(((b1 & 15) << 2) | (b2 >> 6));
    out[o + 3] = table.charCodeAt(b2 & 63);
    o += 4;
    i += 3;
  }
  const rem = n - i;
  if (rem == 1) {
    const b0 = data[i];
    out[o] = table.charCodeAt(b0 >> 2);
    out[o + 1] = table.charCodeAt((b0 & 3) << 4);
    out[o + 2] = 61; // '='
    out[o + 3] = 61;
  } else if (rem == 2) {
    const b0 = data[i];
    const b1 = data[i + 1];
    out[o] = table.charCodeAt(b0 >> 2);
    out[o + 1] = table.charCodeAt(((b0 & 3) << 4) | (b1 >> 4));
    out[o + 2] = table.charCodeAt((b1 & 15) << 2);
    out[o + 3] = 61;
  }
  return String.UTF16.decode(out.buffer);
}

/**
 * Decode standard base64. Returns null on any malformed input: wrong
 * length, invalid character, or bad padding.
 */
export function b64Decode(s: string): Uint8Array | null {
  const len = s.length;
  if (len == 0) return new Uint8Array(0);
  if (len % 4 != 0) return null;
  const table = getDecodeTable();
  let pad = 0;
  if (s.charCodeAt(len - 1) == 61) pad++;
  if (s.charCodeAt(len - 2) == 61) pad++;
  const out = new Uint8Array(len / 4 * 3 - pad);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const lastQuantum = i + 4 == len;
    let acc: i32 = 0;
    for (let k = 0; k < 4; k++) {
      const c = s.charCodeAt(i + k);
      const code = c < 128 ? table[c] : <i8>-1;
      if (code == <i8>-1) return null;
      if (code == <i8>-2) {
        // Padding is only valid in the final quantum, in the last two slots.
        if (!lastQuantum || k < 2) return null;
        if (k == 2 && pad != 2) return null;
        acc <<= 6;
      } else {
        // Data is only valid before the padding region of the final quantum.
        if (pad > 0 && lastQuantum && k >= 4 - pad) return null;
        acc = (acc << 6) | code;
      }
    }
    out[o++] = <u8>(acc >> 16);
    if (o < out.length) out[o++] = <u8>(acc >> 8);
    if (o < out.length) out[o++] = <u8>acc;
  }
  return out;
}
