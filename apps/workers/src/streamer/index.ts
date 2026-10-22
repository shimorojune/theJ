import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { audioCache, songs } from "@thej/db";
import { QUEUES, STREAM_READY_CHANNEL, type StreamJob, type StreamReady } from "@thej/shared";
import { Worker } from "bullmq";
import { eq, lt, sql } from "drizzle-orm";
import { Egress } from "../fetcher/egress";
import { downloadAudio } from "../fetcher/ytdlp";
import { db } from "../lib/db";
import { connection } from "../lib/redis";
import { analyse } from "./analyse";
import { youtubeIdFor } from "./resolve";

/** Where pulled songs live until the sweep removes them. Shared with the api as a volume. */
const DIR = process.env.STREAM_DIR ?? "/data/stream";
/** Unplayed-for-this-long audio is deleted (warm-set songs are pinned and kept). */
const KEEP_MIN = Number(process.env.STREAM_KEEP_MIN ?? 45);

await mkdir(DIR, { recursive: true });
const egress = new Egress(
  process.env.HOME_PROXY || undefined,
  process.env.FALLBACK_PROXY || undefined,
);
egress.start();

const announce = (msg: StreamReady) =>
  connection.publish(STREAM_READY_CHANNEL, JSON.stringify(msg));

const worker = new Worker<StreamJob>(
  QUEUES.stream,
  async (job) => {
    const { songId } = job.data;
    const [cached] = await db.select().from(audioCache).where(eq(audioCache.songId, songId));
    if (cached) {
      await db
        .update(audioCache)
        .set({ lastUsedAt: new Date() })
        .where(eq(audioCache.songId, songId));
      await announce({ songId, ok: true });
      return { cached: true };
    }

    const videoId = await youtubeIdFor(songId);
    if (!videoId) {
      await announce({ songId, ok: false, error: "not on YouTube" });
      return { skipped: "unavailable" };
    }

    const t0 = Date.now();
    const { path: tmp, cleanup } = await downloadAudio(videoId, egress.proxy);
    const path = join(DIR, `${songId.replace(/[^A-Za-z0-9_-]/g, "_")}.m4a`);
    try {
      await rm(path, { force: true });
      // Copy into the shared dir (another mount); cleanup() removes the temp dir afterwards.
      await copyFile(tmp, path);
      const a = await analyse(path);
      const { size } = await stat(path);
      await db
        .insert(audioCache)
        .values({
          songId,
          path,
          bytes: size,
          durationS: a.durationS,
          bpm: a.bpm,
          beats: a.beats,
          beatConfidence: a.confidence,
          key: a.key,
          scale: a.scale,
          mixInS: a.mixInS,
          mixOutS: a.mixOutS,
        })
        .onConflictDoNothing();
      await db
        .update(songs)
        .set({
          tempo: sql`coalesce(${songs.tempo}, ${a.bpm})`,
          key: sql`coalesce(${songs.key}, ${a.key})`,
          scale: sql`coalesce(${songs.scale}, ${a.scale})`,
          durationS: sql`coalesce(${songs.durationS}, ${Math.round(a.durationS)})`,
        })
        .where(eq(songs.id, songId));
      egress.reportJob();
      await announce({ songId, ok: true });
      return {
        bytes: size,
        bpm: a.bpm,
        key: `${a.key} ${a.scale}`,
        ms: Date.now() - t0,
        via: egress.label,
      };
    } catch (err) {
      egress.reportJob(err as Error);
      await rm(path, { force: true });
      throw err;
    } finally {
      await cleanup();
    }
  },
  { connection, concurrency: Number(process.env.STREAM_CONCURRENCY ?? 2) },
);

worker.on("completed", (job, res) => console.log(`stream ${job.data.songId}`, res));
worker.on("failed", async (job, err) => {
  console.error(`stream failed ${job?.data.songId}: ${err.message}`);
  if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    await announce({ songId: job.data.songId, ok: false, error: err.message });
  }
});

/** Delete audio nobody has used for KEEP_MIN minutes. */
async function sweep() {
  const old = await db
    .select({ songId: audioCache.songId, path: audioCache.path })
    .from(audioCache)
    .where(lt(audioCache.lastUsedAt, new Date(Date.now() - KEEP_MIN * 60_000)));
  for (const row of old) {
    if (await isPinned(row.songId)) continue;
    await rm(row.path, { force: true });
    await db.delete(audioCache).where(eq(audioCache.songId, row.songId));
  }
  if (old.length) console.log(`swept ${old.length} files`);
}
async function isPinned(songId: string) {
  const [r] = await db
    .select({ p: audioCache.pinned })
    .from(audioCache)
    .where(eq(audioCache.songId, songId));
  return Boolean(r?.p);
}
setInterval(() => void sweep().catch((e) => console.error("sweep", e)), 5 * 60_000).unref();

console.log(`streamer up (dir ${DIR}, egress ${egress.label}, keep ${KEEP_MIN} min)`);
