import { createHmac, timingSafeEqual } from "node:crypto";

const sig = (videoId: string, exp: number, secret: string) =>
  createHmac("sha256", secret).update(`${videoId}.${exp}`).digest("base64url");

/** Short-lived audio URL, so the phone never needs a token to stream (RNTP can't send one). */
export function signAudioUrl(
  base: string,
  videoId: string,
  secret: string,
  ttlS = 6 * 3600,
  route: "audio" | "preview" = "audio",
) {
  const exp = Math.floor(Date.now() / 1000) + ttlS;
  return `${base}/${route}/${videoId}?exp=${exp}&sig=${sig(videoId, exp, secret)}`;
}

export function verifyAudioSig(videoId: string, exp: number, given: string, secret: string) {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const a = Buffer.from(sig(videoId, exp, secret));
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
