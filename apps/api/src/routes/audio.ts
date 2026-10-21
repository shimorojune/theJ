import { getAudio, verifyAudioSig } from "@thej/core";
import { tracks } from "@thej/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../deps";
import { env } from "../env";

/** Streams cached audio from MinIO. Auth is the signed URL, since the native player can't send headers. */
export const audio = new Hono().get("/:videoId", async (c) => {
  const videoId = c.req.param("videoId");
  const ok = verifyAudioSig(
    videoId,
    Number(c.req.query("exp")),
    c.req.query("sig") ?? "",
    env.AUDIO_URL_SIGNING_SECRET,
  );
  if (!ok) return c.json({ error: "bad or expired signature" }, 403);

  const [t] = await db
    .select({ key: tracks.audioKey })
    .from(tracks)
    .where(eq(tracks.videoId, videoId));
  if (!t?.key) return c.json({ error: "not cached" }, 404);

  const a = await getAudio(t.key, c.req.header("range"));
  const headers: Record<string, string> = {
    "Content-Type": a.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };
  if (a.contentLength !== undefined) headers["Content-Length"] = String(a.contentLength);
  if (a.contentRange) headers["Content-Range"] = a.contentRange;
  return c.body(a.body, a.partial ? 206 : 200, headers);
});
