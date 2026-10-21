import { setTimeout as sleep } from "node:timers/promises";
import { tracks } from "@thej/db";
import { type FetchJob, QUEUES } from "@thej/shared";
import { Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { enqueueAnalyse } from "../lib/queues";
import { connection } from "../lib/redis";
import { audioKey, ensureBucket, uploadAudio } from "../lib/s3";
import { Egress, isBotCheck } from "./egress";
import { downloadAudio } from "./ytdlp";

await ensureBucket();

const concurrency = Number(process.env.FETCH_CONCURRENCY ?? 1);
// When YouTube asks for a bot check, every download from that IP fails for a while. Pause the whole
// queue instead of burning each song's attempts.
const cooldownMs = Number(process.env.FETCH_BLOCK_COOLDOWN_MIN ?? 30) * 60_000;
const egress = new Egress(
  process.env.HOME_PROXY || undefined,
  process.env.FALLBACK_PROXY || undefined,
);
egress.start();

// Deliberately slow. At 2 slots with 2–6 s gaps the home IP hit the bot check after ~30 songs
// (2026-10-21), so the default is 1 slot with 8–20 s gaps (~3 songs a minute).
const jitter = () => sleep(8000 + Math.random() * 12_000);

const worker = new Worker<FetchJob>(
  QUEUES.fetch,
  async (job) => {
    const { videoId } = job.data;
    const [track] = await db.select().from(tracks).where(eq(tracks.videoId, videoId));
    if (!track) throw new Error(`unknown track ${videoId}`);
    if (track.audioKey && (track.status === "fetched" || track.status === "ready")) {
      if (track.status === "fetched") await enqueueAnalyse(videoId);
      return { skipped: true };
    }

    await db.update(tracks).set({ status: "fetching" }).where(eq(tracks.videoId, videoId));
    try {
      const { path, cleanup } = await downloadAudio(videoId, egress.proxy);
      try {
        const key = audioKey(videoId);
        const bytes = await uploadAudio(key, path);
        await db
          .update(tracks)
          .set({ status: "fetched", audioKey: key, audioBytes: bytes, failCount: 0 })
          .where(eq(tracks.videoId, videoId));
        egress.reportJob();
        await enqueueAnalyse(videoId);
        return { bytes, via: egress.label };
      } finally {
        await cleanup();
      }
    } catch (err) {
      egress.reportJob(err as Error);
      if (isBotCheck(err as Error) && !egress.canSwitch) {
        console.warn(
          `bot check on ${egress.label} egress; pausing fetches for ${cooldownMs / 60_000} min`,
        );
        await db.update(tracks).set({ status: "new" }).where(eq(tracks.videoId, videoId));
        await worker.rateLimit(cooldownMs);
        throw Worker.RateLimitError();
      }
      const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      await db
        .update(tracks)
        .set({ status: last ? "failed" : "new", failCount: sql`${tracks.failCount} + 1` })
        .where(eq(tracks.videoId, videoId));
      throw err;
    } finally {
      await jitter();
    }
  },
  { connection, concurrency },
);

worker.on("completed", (job, res) => console.log(`fetched ${job.data.videoId}`, res));
worker.on("failed", (job, err) =>
  console.error(`fetch failed ${job?.data.videoId}: ${err.message}`),
);
console.log(`fetcher up (concurrency ${concurrency}, egress ${egress.label})`);
