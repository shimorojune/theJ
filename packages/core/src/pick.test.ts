import assert from "node:assert/strict";
import { test } from "node:test";
import { camelot, keyClash } from "./pick";

test("keys land on the Camelot wheel", () => {
  assert.deepEqual(camelot("C", "major"), { n: 8, minor: false });
  assert.deepEqual(camelot("A", "minor"), { n: 8, minor: true });
  assert.deepEqual(camelot("G", "major"), { n: 9, minor: false });
  assert.deepEqual(camelot("Bb", "major"), { n: 6, minor: false });
  assert.deepEqual(camelot("F#", "minor"), { n: 11, minor: true });
  assert.deepEqual(camelot("Eb", "minor"), { n: 2, minor: true });
  assert.equal(camelot(null, "major"), null);
});

test("neighbours and relatives blend, far keys clash", () => {
  const k = (key: string, scale: string) => camelot(key, scale);
  assert.equal(keyClash(k("C", "major"), k("A", "minor")), 0);
  assert.equal(keyClash(k("C", "major"), k("G", "major")), 0);
  assert.equal(keyClash(k("C", "major"), k("F", "major")), 0);
  assert.equal(keyClash(k("C", "major"), k("D", "major")), 0.5);
  assert.equal(keyClash(k("C", "major"), k("F#", "major")), 1);
  assert.equal(keyClash(null, k("C", "major")), 0.5);
});
