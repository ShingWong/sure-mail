// base64: bytes cross the relay wire and the store RPC as canonical
// base64 (padded, no whitespace) — the same encoding Buffer.toString
// ("base64") emits on the Node side (docs/relay.md).

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked to stay under the argument limit of String.fromCharCode.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
