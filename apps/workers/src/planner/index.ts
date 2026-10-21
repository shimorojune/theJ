import { type PlanJob, QUEUES } from "@thej/shared";
import { Worker } from "bullmq";
import { connection } from "../lib/redis";

// TODO(build step 2): scorer, target ramp, commit next-2, candidate pool from Last.fm + cache.
// TODO(build step 4): interpret / refill via OpenRouter (AI SDK), bucketed suggestion cache, daily cap.
const worker = new Worker<PlanJob>(
  QUEUES.plan,
  async (job) => {
    console.log(`plan ${job.data.sessionId} (${job.data.reason}): not implemented yet`);
  },
  { connection, concurrency: 4 },
);

worker.on("failed", (job, err) => console.error(`plan failed ${job?.data.sessionId}: ${err.message}`));
console.log("planner worker up");
