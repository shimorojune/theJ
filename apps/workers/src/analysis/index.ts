import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadObject } from "@thej/core";
import { tracks } from "@thej/db";
import { type AnalyseJob, QUEUES } from "@thej/shared";
import { DelayedError, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { connection } from "../lib/redis";
import { cutClip, probeDuration } from "./clip";
import { wordsPerMinute } from "./lyrics";
import { extractFeatures, RateLimited } from "./reccobeats";

// TODO(hardening): Essentia fallback behind the same Features shape when ReccoBeats keeps 429ing.
const worker = new Worker<AnalyseJob>(
  QUEUES.analyse,
  async (job, token) => {
    const { videoId } = job.data;
    const [track] = await db.select().from(tracks).where(eq(tracks.videoId, videoId));
    if (!track?.audioKey) throw new Error(`track ${videoId} has no audio yet`);
    if (track.status === "ready") return { skipped: true };

    const dir = await mkdtemp(join(tmpdir(), "thej-an-"));
    try {
      const audio = join(dir, "audio.m4a");
      await downloadObject(track.audioKey, audio);
      const durationS = track.durationS ?? Math.round(await probeDuration(audio));
      const clip = await cutClip(audio, dir, durationS);

      let f: Awaited<ReturnType<typeof extractFeatures>>;
      try {
        f = await extractFeatures(clip);
      } catch (err) {
        if (err instanceof RateLimited && token) {
          // Back off without burning an attempt.
          await job.moveToDelayed(Date.now() + err.retryAfterS * 1000, token);
          throw new DelayedError();
        }
        throw err;
      }
      const lyricWpm = await wordsPerMinute(track.title, track.artist, durationS).catch(() => null);
      const wpm = lyricWpm ?? (f.instrumentalness > 0.5 ? 0 : null);

      await db
        .update(tracks)
        .set({
          status: "ready",
          durationS,
          energy: f.energy,
          valence: f.valence,
          tempo: f.tempo,
          dance: f.danceability,
          speech: f.speechiness,
          acoustic: f.acousticness,
          instrumental: f.instrumentalness,
          loudness: f.loudness,
          wordsPerMin: wpm,
        })
        .where(eq(tracks.videoId, videoId));
      return { energy: f.energy, valence: f.valence, tempo: Math.round(f.tempo), wpm };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  // ReccoBeats' limits are unpublished; stay gentle.
  { connection, concurrency: 2, limiter: { max: 1, duration: 1500 } },
);

worker.on("completed", (job, res) => console.log(`ready ${job.data.videoId}`, res));
worker.on("failed", (job, err) =>
  console.error(`analyse failed ${job?.data.videoId}: ${err.message}`),
);
console.log("analysis worker up");
