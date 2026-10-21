import { type AnalyseJob, QUEUES } from "@thej/shared";
import { Worker } from "bullmq";
import { connection } from "../lib/redis";

// TODO(build step 1): cut a 30 s mono MP3 at the 35% mark, send to ReccoBeats, write features,
// add LRCLIB words-per-minute, mark track ready. Essentia fallback on 429.
const worker = new Worker<AnalyseJob>(
  QUEUES.analyse,
  async (job) => {
    console.log(`analyse ${job.data.videoId}: not implemented yet`);
  },
  { connection, concurrency: 2 },
);

worker.on("failed", (job, err) => console.error(`analyse failed ${job?.data.videoId}: ${err.message}`));
console.log("analysis worker up");
