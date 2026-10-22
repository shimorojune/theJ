import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { verifyAudioSig } from "@thej/core";
import { audioCache } from "@thej/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../deps";
import { env } from "../env";

/**
 * Streams a pulled song from the streamer's shared directory. Auth is the signed URL, since the
 * native player can't send headers. Supports HTTP ranges so the phone can seek and pre-buffer.
 */
export const audio = new Hono().get("/:songId", async (c) => {
  const songId = c.req.param("songId");
  const ok = verifyAudioSig(
    songId,
    Number(c.req.query("exp")),
    c.req.query("sig") ?? "",
    env.AUDIO_URL_SIGNING_SECRET,
  );
  if (!ok) return c.json({ error: "bad or expired signature" }, 403);

  const [row] = await db
    .select({ path: audioCache.path })
    .from(audioCache)
    .where(eq(audioCache.songId, songId));
  if (!row) return c.json({ error: "not ready" }, 404);
  const path = env.STREAM_DIR ? row.path.replace(/^.*\/stream\//, `${env.STREAM_DIR}/`) : row.path;
  const { size } = await stat(path).catch(() => ({ size: 0 }));
  if (!size) return c.json({ error: "not ready" }, 404);
  void db.update(audioCache).set({ lastUsedAt: new Date() }).where(eq(audioCache.songId, songId));

  const range = c.req.header("range");
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  const start = m?.[1] ? Number(m[1]) : 0;
  const end = m?.[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size) return c.body(null, 416, { "Content-Range": `bytes */${size}` });

  const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
  const headers: Record<string, string> = {
    "Content-Type": "audio/mp4",
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
    "Cache-Control": "private, max-age=3600",
  };
  if (m) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return c.body(body, m ? 206 : 200, headers);
});
