import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyAudioSig } from "@thej/core";
import { Hono } from "hono";
import { env } from "../env";

/** The parts the streamer writes per song (apps/workers/src/streamer/stems.py). */
export const STEM_PARTS = [
  "in-drums",
  "in-other",
  "in-rest",
  "out-vocals",
  "out-bass",
  "out-rest",
] as const;
export type StemPart = (typeof STEM_PARTS)[number];

const DIR = join(env.STREAM_DIR ?? "/data/stream", "stems");

/**
 * One stem of a song's mix window, for the phone's DJ hand-over. Signed like /audio, over
 * `<songId>/<part>`. A few hundred KB each, so served whole.
 */
export const stems = new Hono().get("/:songId/:part", async (c) => {
  const { songId, part } = c.req.param();
  if (!STEM_PARTS.includes(part as StemPart)) return c.json({ error: "unknown stem" }, 404);
  const ok = verifyAudioSig(
    `${songId}/${part}`,
    Number(c.req.query("exp")),
    c.req.query("sig") ?? "",
    env.AUDIO_URL_SIGNING_SECRET,
  );
  if (!ok) return c.json({ error: "bad or expired signature" }, 403);
  const body = await readFile(
    join(DIR, `${songId.replace(/[^A-Za-z0-9_-]/g, "_")}.${part}.m4a`),
  ).catch(() => null);
  if (!body) return c.json({ error: "no stem" }, 404);
  return c.body(body, 200, {
    "Content-Type": "audio/mp4",
    "Content-Length": String(body.length),
    "Cache-Control": "private, max-age=86400",
  });
});
