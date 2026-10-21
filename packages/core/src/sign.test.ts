import assert from "node:assert/strict";
import { test } from "node:test";
import { signAudioUrl, verifyAudioSig } from "./sign";

test("signed audio URLs verify, and tampering or expiry fails", () => {
  const url = new URL(signAudioUrl("https://api.test", "NJAv_7lHUIU", "secret"));
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  assert.equal(verifyAudioSig("NJAv_7lHUIU", exp, sig, "secret"), true);
  assert.equal(verifyAudioSig("fsiPzT50ZiM", exp, sig, "secret"), false);
  assert.equal(verifyAudioSig("NJAv_7lHUIU", exp, sig, "other"), false);
  assert.equal(verifyAudioSig("NJAv_7lHUIU", exp + 1, sig, "secret"), false);
  assert.equal(verifyAudioSig("NJAv_7lHUIU", 1, sig, "secret"), false);
});
