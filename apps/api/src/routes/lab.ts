import { signAudioUrl } from "@thej/core";
import { audioCache, songs } from "@thej/db";
import { desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type AuthVars, requireAuth } from "../auth";
import { db, queues } from "../deps";
import { env } from "../env";

/**
 * Transition R&D (tools/mixlab): every pulled song with its analysis and a signed audio URL, so
 * mixes can be rendered and scored offline exactly as the phone would play them.
 */
export const lab = new Hono<AuthVars>()
  .use(requireAuth)
  // Build a test corpus: pull `n` well-known songs (on many playlists) in the background.
  .post("/pull", async (c) => {
    const n = Math.min(200, Number(c.req.query("n") ?? 40) || 40);
    const rows = await db.execute<{ id: string }>(sql`
      select id from (
        select id from songs where unavailable_at is null order by source_count desc limit 3000
      ) top order by random() limit ${n}`);
    for (const r of rows) await queues.enqueueStream(r.id, 9);
    return c.json({ queued: rows.length });
  })
  .get("/songs", async (c) => {
    const limit = Math.min(500, Number(c.req.query("limit") ?? 200) || 200);
    const rows = await db
      .select({ song: songs, cache: audioCache })
      .from(audioCache)
      .innerJoin(songs, eq(songs.id, audioCache.songId))
      .orderBy(desc(audioCache.readyAt))
      .limit(limit);
    return c.json(
      rows.map(({ song, cache }) => ({
        songId: song.id,
        title: song.title,
        artist: song.artist,
        languages: song.languages,
        energy: song.energy,
        valence: song.valence,
        durationS: cache.durationS,
        bpm: cache.bpm,
        beats: cache.beats,
        beatConfidence: cache.beatConfidence,
        key: cache.key,
        scale: cache.scale,
        mixInS: cache.mixInS,
        mixOutS: cache.mixOutS,
        previewOffsetS: cache.previewOffsetS,
        previewMatch: cache.previewMatch,
        audioUrl: signAudioUrl(env.PUBLIC_API_URL, song.id, env.AUDIO_URL_SIGNING_SECRET),
      })),
    );
  });
