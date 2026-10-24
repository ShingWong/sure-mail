// decode_text port: the core hands us raw bytes + a charset label; we use
// the host TextDecoder (full WHATWG charset coverage). Unknown labels fall
// back to single-byte decoding — the core always gets a string back.
// Identical behavior to the Node host's decode port (host-node/src/decode.ts).

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

export function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return latin1(bytes);
  }
}
