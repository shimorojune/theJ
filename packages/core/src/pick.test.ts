import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedLanguages, camelot, countLanguage, keyClash, nextLanguages } from "./pick";

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

test("English/Hindi mix holds the listener's share", () => {
  const recent = { hi: 0, en: 0 };
  const seq: string[] = [];
  for (let i = 0; i < 10; i++) {
    const [l] = nextLanguages(["en", "hi"], 0.3, recent);
    seq.push(l as string);
    countLanguage(recent, [l as string]);
  }
  assert.equal(seq.filter((l) => l === "hi").length, 3);
  assert.deepEqual(nextLanguages(["en"], 0.3, recent), ["en"]);
  assert.deepEqual(allowedLanguages(["en", "hi"]), ["en", "hi", "pa", "ur"]);
});
