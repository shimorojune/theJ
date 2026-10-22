import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { previewUrlFor, verifyAudioSig } from "@thej/core";
import { Hono } from "hono";
import { db } from "../deps";
import { env } from "../env";

const DIR = join(env.STREAM_DIR ?? "/data/stream", "previews");
const fileFor = (songId: string) => join(DIR, `${songId.replace(/[^A-Za-z0-9_-]/g, "_")}.m4a`);
const inFlight = new Map<string, Promise<string | null>>();

/** The song's 30-second store preview on disk, fetched once and kept beside the streamed audio. */
export function warmPreview(songId: string): Promise<string | null> {
  let p = inFlight.get(songId);
  if (!p) {
    p = (async () => {
      const path = fileFor(songId);
      if (
        await stat(path)
          .then((s) => s.size > 0)
          .catch(() => false)
      )
        return path;
      const url = await previewUrlFor(db, songId);
      if (!url) return null;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`preview ${res.status}`);
      await mkdir(DIR, { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
      await rename(tmp, path);
      return path;
    })().finally(() => inFlight.delete(songId));
    inFlight.set(songId, p);
  }
  return p;
}

/**
 * The preview the phone starts on while the full song is pulled. Auth is the signed URL, as for
 * /audio. 404 when the song has no preview; the phone then waits for the full audio.
 */
export const preview = new Hono().get("/:songId", async (c) => {
  const songId = c.req.param("songId");
  const ok = verifyAudioSig(
    songId,
    Number(c.req.query("exp")),
    c.req.query("sig") ?? "",
    env.AUDIO_URL_SIGNING_SECRET,
  );
  if (!ok) return c.json({ error: "bad or expired signature" }, 403);
  const path = await warmPreview(songId).catch(() => null);
  if (!path) return c.json({ error: "no preview" }, 404);
  const body = await readFile(path);
  return c.body(body, 200, {
    "Content-Type": "audio/mp4",
    "Content-Length": String(body.length),
    "Cache-Control": "private, max-age=86400",
  });
});
