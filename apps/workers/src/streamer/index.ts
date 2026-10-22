import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { previewUrlFor } from "@thej/core";
import { audioCache, songs } from "@thej/db";
import { QUEUES, STREAM_READY_CHANNEL, type StreamJob, type StreamReady } from "@thej/shared";
import { Worker } from "bullmq";
import { and, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { Egress } from "../fetcher/egress";
import { downloadAudio } from "../fetcher/ytdlp";
import { db } from "../lib/db";
import { connection } from "../lib/redis";
import { analyse, previewOffset, STEM_PARTS, splitStems } from "./analyse";
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

/** The song's store preview, shared with the api (same path scheme as its /preview route). */
async function previewFile(songId: string): Promise<string | null> {
  const path = join(DIR, "previews", `${songId.replace(/[^A-Za-z0-9_-]/g, "_")}.m4a`);
  if (
    await stat(path)
      .then((s) => s.size > 0)
      .catch(() => false)
  )
    return path;
  const url = await previewUrlFor(db, songId);
  if (!url) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  await mkdir(join(DIR, "previews"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await rename(tmp, path);
  return path;
}

/** Stem files of a song: `<dir>/stems/<id>.<part>.m4a` (shared with the api). */
const stemPrefix = (songId: string) => join(DIR, "stems", songId.replace(/[^A-Za-z0-9_-]/g, "_"));

/**
 * Stems are split one song at a time after the song is ready, so they never hold up playback;
 * a song mixes the classic way until its stems are there. Fresh pulls (songs a listener is
 * about to hear) jump ahead of the backfill of older cached songs.
 */
type StemJob = { songId: string; path: string; a: Parameters<typeof splitStems>[2] };
const stemUrgent: StemJob[] = [];
const stemBacklog: StemJob[] = [];
let stemBusy = false;
function queueStems(job: StemJob, urgent: boolean) {
  (urgent ? stemUrgent : stemBacklog).push(job);
  void drainStems();
}
async function drainStems() {
  if (stemBusy) return;
  stemBusy = true;
  try {
    for (
      let job = stemUrgent.shift() ?? stemBacklog.shift();
      job;
      job = stemUrgent.shift() ?? stemBacklog.shift()
    ) {
      const t0 = Date.now();
      try {
        await mkdir(join(DIR, "stems"), { recursive: true });
        const { inS, outS } = await splitStems(job.path, stemPrefix(job.songId), job.a);
        await db
          .update(audioCache)
          .set({ stemsInS: inS, stemsOutS: outS })
          .where(eq(audioCache.songId, job.songId));
        console.log(
          `stems ${job.songId} in ${Date.now() - t0} ms (${stemUrgent.length} + ${stemBacklog.length} waiting)`,
        );
      } catch (err) {
        console.error(`stems failed ${job.songId}: ${(err as Error).message}`);
      }
    }
  } finally {
    stemBusy = false;
  }
}

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
      // Where the preview sits in this audio, so a phone playing the preview swaps over seamlessly.
      const pv = await previewFile(songId)
        .then((p) => (p ? previewOffset(path, p) : null))
        .catch(() => null);
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
          mixInBeatS: a.mixInBeatS,
          mixOutBeatS: a.mixOutBeatS,
          previewOffsetS: pv?.offsetS ?? null,
          previewMatch: pv?.match ?? null,
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
      queueStems({ songId, path, a }, true);
      return {
        bytes: size,
        bpm: a.bpm,
        key: `${a.key} ${a.scale}`,
        preview: pv ? `${pv.offsetS ?? "no match"} (${pv.match})` : "none",
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
    for (const part of STEM_PARTS)
      await rm(`${stemPrefix(row.songId)}.${part}.m4a`, { force: true });
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

/** Songs pulled before mix points carried a fitted beat grid: analyse them again, one at a time. */
async function reanalyse() {
  const rows = await db
    .select({ songId: audioCache.songId, path: audioCache.path })
    .from(audioCache)
    .where(isNull(audioCache.mixOutBeatS));
  for (const row of rows) {
    const a = await analyse(row.path).catch(() => null);
    if (!a) continue;
    await db
      .update(audioCache)
      .set({
        mixInS: a.mixInS,
        mixOutS: a.mixOutS,
        mixInBeatS: a.mixInBeatS,
        mixOutBeatS: a.mixOutBeatS,
      })
      .where(eq(audioCache.songId, row.songId));
  }
  if (rows.length) console.log(`reanalysed ${rows.length} songs`);
}
/** Songs pulled before stems existed get theirs, behind any new pulls' stems. */
async function backfillStems() {
  // Most recently played first: those are the songs likely to come round again.
  const rows = await db
    .select()
    .from(audioCache)
    .where(and(isNull(audioCache.stemsOutS), isNotNull(audioCache.mixOutS)))
    .orderBy(desc(audioCache.lastUsedAt));
  for (const r of rows)
    queueStems(
      {
        songId: r.songId,
        path: r.path,
        a: {
          bpm: r.bpm ?? 0,
          mixInS: r.mixInS ?? 0,
          mixOutS: r.mixOutS ?? 0,
          mixInBeatS: r.mixInBeatS,
          mixOutBeatS: r.mixOutBeatS,
        },
      },
      false,
    );
  if (rows.length) console.log(`stems queued for ${rows.length} cached songs`);
}
// Stems for older cached songs only when STEMS_BACKFILL=1: on the VPS the backfill starved
// downloads and the api (a mood start took 30 s), so by default only fresh pulls get stems.
void reanalyse()
  .catch((e) => console.error("reanalyse", e))
  .then(() => (process.env.STEMS_BACKFILL === "1" ? backfillStems() : undefined))
  .catch((e) => console.error("stems backfill", e));

console.log(`streamer up (dir ${DIR}, egress ${egress.label}, keep ${KEEP_MIN} min)`);
