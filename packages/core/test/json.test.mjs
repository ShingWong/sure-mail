// Hand-rolled JSON (src/json) through the real probes.wasm, checked
// against the Node JSON oracle. AS 0.28 ships no JSON and no exceptions,
// so this module carries the whole JSON contract of the ABI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProbes } from "./helpers/load.mjs";

const probes = await loadProbes();

function oracle(input) {
  return JSON.stringify(JSON.parse(input));
}

const validInputs = [
  "null",
  "true",
  "false",
  "0",
  "-0",
  "42",
  "-42",
  "3.5",
  "-0.5",
  "1e3",
  "1E3",
  "1e+3",
  "1.5e-2",
  "9007199254740991",
  "4294967295",
  "\"\"",
  "\"hello\"",
  "\"a\\\"b\"",
  "\"a\\\\b\"",
  "\"a\\/b\"",
  "\"\\b\\f\\n\\r\\t\"",
  "\"\\u0041\\u00e9\\u20ac\"",
  "\"\\ud83d\\ude00\"", // surrogate pair
  "[]",
  "[1,2,3]",
  "[[]]",
  "[1,[2,[3]]]",
  "{}",
  "{\"a\":1}",
  "{\"a\":{\"b\":[1,2,{\"c\":null}]}}",
  "  {  \"spaced\"  :  [ 1 , 2 ]  }  ",
  "{\"a\":1,\"a\":2}", // duplicate key: last wins, like JS
];

for (const input of validInputs) {
  test(`roundtrip: ${input}`, () => {
    assert.equal(probes.probeJson(input), oracle(input));
  });
}

const invalidInputs = [
  "",
  "   ",
  "nul",
  "tru",
  "+1",
  "01",
  "-",
  "1.",
  ".5",
  "1.e5",
  "1e",
  "1e+",
  "0x10",
  "NaN",
  "Infinity",
  "'single'",
  "{a:1}",
  "{\"a\" 1}",
  "{\"a\":}",
  "{\"a\":1}x",
  "[1 2]",
  "[,1]",
  "[1,",
  "[1,2,3,]",
  "{\"a\":1,}",
  "\"unterminated",
  "\"bad \\q escape\"",
  "\"bad \\u12g4\"",
  "\"raw \u0001 control\"", // unescaped control character
  "\"tab in string\t\"",
  "{\"a\":1", // truncated object
  "// comment\n1",
];

for (const input of invalidInputs) {
  test(`rejects: ${JSON.stringify(input)}`, () => {
    assert.equal(probes.probeJson(input), "INVALID");
  });
}

test("deep nesting beyond the depth limit is rejected", () => {
  const depth = 100;
  const input = "[".repeat(depth) + "]".repeat(depth);
  assert.equal(probes.probeJson(input), "INVALID");
  const shallow = "[".repeat(60) + "]".repeat(60);
  assert.equal(probes.probeJson(shallow), oracle(shallow));
});

test("field access: getString/getInt with fallbacks", () => {
  const s = '{"name":"inbox","uid":17,"unread":true}';
  assert.equal(probes.probeJsonString(s, "name", "?"), "inbox");
  assert.equal(probes.probeJsonString(s, "nope", "?"), "?");
  assert.equal(probes.probeJsonInt(s, "uid", -1), 17);
  assert.equal(probes.probeJsonInt(s, "nope", -1), -1);
  assert.equal(probes.probeJsonString("oops", "name", "?"), "INVALID");
});

test("field access: nested values as canonical JSON", () => {
  const s = '{"a":{"b":[1,2]},"s":"x"}';
  assert.equal(probes.probeJsonField(s, "a"), '{"b":[1,2]}');
  assert.equal(probes.probeJsonField(s, "s"), '"x"');
  assert.equal(probes.probeJsonField(s, "missing"), "MISSING");
});

test("stringify escapes lone surrogates but keeps valid pairs", () => {
  const parsed = "\ud800 ok \udfff \ud83d\ude00";
  const roundtrip = probes.probeJson(JSON.stringify(parsed));
  assert.equal(roundtrip, JSON.stringify(parsed), "same canonical form as JS");
  assert.equal(JSON.parse(roundtrip), parsed, "and the result stays parseable");
});

test("large payloads survive intact", () => {
  const big = { items: Array.from({ length: 500 }, (_, i) => ({ uid: i, text: `msg ${i} ünïcode` })) };
  const input = JSON.stringify(big);
  const out = probes.probeJson(input);
  assert.deepEqual(JSON.parse(out), big);
});
