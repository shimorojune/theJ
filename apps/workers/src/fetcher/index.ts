import { setTimeout as sleep } from "node:timers/promises";
import { type FetchJob, QUEUES } from "@thej/shared";
import { Worker } from "bullmq";
import { connection } from "../lib/redis";
import { audioKey, uploadAudio } from "../lib/s3";
import { downloadAudio } from "./ytdlp";

const concurrency = Number(process.env.FETCH_CONCURRENCY ?? 2);
const jitter = () => sleep(2000 + Math.random() * 4000);

// TODO(build step 1): update tracks.status, emit analyse job, home-proxy health check + fallback.
const worker = new Worker<FetchJob>(
  QUEUES.fetch,
  async (job) => {
    const proxy = process.env.HOME_PROXY || undefined;
    const { path, cleanup } = await downloadAudio(job.data.videoId, proxy);
    try {
      const bytes = await uploadAudio(audioKey(job.data.videoId), path);
      return { bytes };
    } finally {
      await cleanup();
      await jitter();
    }
  },
  { connection, concurrency },
);

worker.on("completed", (job, res) => console.log(`fetched ${job.data.videoId}`, res));
worker.on("failed", (job, err) =>
  console.error(`fetch failed ${job?.data.videoId}: ${err.message}`),
);
console.log(
  `fetcher up (concurrency ${concurrency}, proxy ${process.env.HOME_PROXY ? "home" : "none"})`,
);
