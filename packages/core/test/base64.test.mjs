// Base64 (src/encoding/base64) through the real probes.wasm: RFC 4648
// vectors, Node Buffer oracles, and strict rejection of malformed input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProbes } from "./helpers/load.mjs";

const probes = await loadProbes();

test("encode matches RFC 4648 vectors", () => {
  const vectors = ["", "f", "fo", "foo", "foob", "fooba", "foobar"];
  for (const s of vectors) {
    assert.equal(probes.probeB64Encode(s), Buffer.from(s, "utf8").toString("base64"), `encode ${JSON.stringify(s)}`);
  }
});

test("decode matches RFC 4648 vectors", () => {
  const vectors = ["", "Zg==", "Zm8=", "Zm9v", "Zm9vYg==", "Zm9vYmE=", "Zm9vYmFy"];
  for (const b64 of vectors) {
    const hex = probes.probeB64Decode(b64);
    assert.equal(hex, Buffer.from(b64, "base64").toString("hex"), `decode ${b64}`);
  }
});

test("encode/decode roundtrip on multi-byte UTF-8 text", () => {
  const text = "héllo wörld — ünïcödé ✓ 漢字 emoji 😀";
  const b64 = probes.probeB64Encode(text);
  assert.equal(b64, Buffer.from(text, "utf8").toString("base64"));
  const bytes = Buffer.from(probes.probeB64Decode(b64), "hex");
  assert.equal(bytes.toString("utf8"), text);
});

test("roundtrip on all byte values and long inputs", () => {
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  for (const payload of [all, Buffer.concat([all, all, all]), Buffer.alloc(1000, 0xab)]) {
    const b64 = probes.probeB64Encode(payload.toString("binary"));
    // probeB64Encode encodes the UTF-8 bytes of its argument, so use
    // binary strings whose UTF-8 encoding equals the raw bytes (< 0x80)
    // — full-range coverage comes from decode + the roundtrip below.
    assert.equal(b64, Buffer.from(payload.toString("binary"), "utf8").toString("base64"));
  }
  const raw = Buffer.from(Array.from({ length: 999 }, (_, i) => (i * 37) & 0xff));
  const b64 = raw.toString("base64");
  const hex = probes.probeB64Decode(b64);
  assert.equal(Buffer.from(hex, "hex").compare(raw), 0);
});

test("decode rejects malformed input", () => {
  const bad = [
    "A", // length % 4 != 0
    "AAAAA",
    "AA A", // invalid character
    "A!==",
    "=AAA", // padding in data slots
    "AA=A", // interleaved padding
    "====", // padding only
    "AAA=AAAA", // padding in non-final quantum
    "AB*D",
  ];
  for (const s of bad) {
    assert.equal(probes.probeB64Decode(s), "INVALID", `should reject ${JSON.stringify(s)}`);
  }
});

test("empty input edge cases", () => {
  assert.equal(probes.probeB64Encode(""), "");
  assert.equal(probes.probeB64Decode(""), ""); // decodes to zero bytes = empty hex
});
