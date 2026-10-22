import { signAudioUrl, songLanguages } from "@thej/core";
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
  // Picker diagnostics: how the catalogue's languages look to the picker (read-only, fixed queries).
  .get("/stats", async (c) => {
    const q = async (query: ReturnType<typeof sql>) => db.execute(query);
    const [pgvector, effective, tagged, guessOfTagged, sample] = await Promise.all([
      q(sql`select extversion from pg_extension where extname = 'vector'`),
      q(sql`select ${songLanguages} as langs, count(*)::int n from songs s
            where s.embedding is not null and not s.junk group by 1 order by 2 desc limit 12`),
      q(sql`select languages, count(*)::int n from songs where languages <> '{}'
            group by 1 order by 2 desc limit 10`),
      // How often the guess agrees with the tagger, per tagged language.
      q(sql`select languages[1] as tag, lang_guess[1] as guess, count(*)::int n from songs
            where languages <> '{}' group by 1, 2 order by 3 desc limit 20`),
      q(sql`select title, artist, labels, lang_guess from songs
            where languages @> '{hi}' and lang_guess @> '{en}' order by random() limit 15`),
    ]);
    return c.json({ pgvector, effective, tagged, guessOfTagged, sample });
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
        mixInBeatS: cache.mixInBeatS,
        mixOutBeatS: cache.mixOutBeatS,
        stemsInS: cache.stemsInS,
        stemsOutS: cache.stemsOutS,
        previewOffsetS: cache.previewOffsetS,
        previewMatch: cache.previewMatch,
        audioUrl: signAudioUrl(env.PUBLIC_API_URL, song.id, env.AUDIO_URL_SIGNING_SECRET),
      })),
    );
  });
