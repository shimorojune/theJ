import { type AnalyseJob, type FetchJob, PRIORITY, QUEUES } from "@thej/shared";
import { type JobsOptions, Queue } from "bullmq";
import { connection } from "./redis";

export const fetchQueue = new Queue<FetchJob>(QUEUES.fetch, { connection });
export const analyseQueue = new Queue<AnalyseJob>(QUEUES.analyse, { connection });

// jobId = videoId, so a song already waiting is never queued twice.
const base = (videoId: string): JobsOptions => ({
  jobId: videoId,
  attempts: 3,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
});

export function enqueueFetch(videoId: string, priority: number = PRIORITY.pool) {
  return fetchQueue.add("fetch", { videoId }, { ...base(videoId), priority });
}

export function enqueueAnalyse(videoId: string) {
  return analyseQueue.add("analyse", { videoId }, base(videoId));
}
