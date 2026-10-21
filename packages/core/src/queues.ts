import { type AnalyseJob, type FetchJob, type PlanJob, PRIORITY, QUEUES } from "@thej/shared";
import { type JobsOptions, Queue } from "bullmq";
import type { Redis } from "ioredis";

// jobId = videoId, so a song already waiting is never queued twice.
const once = (id: string): JobsOptions => ({
  jobId: id,
  attempts: 3,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
});

export function createQueues(connection: Redis) {
  const fetch = new Queue<FetchJob>(QUEUES.fetch, { connection });
  const analyse = new Queue<AnalyseJob>(QUEUES.analyse, { connection });
  const plan = new Queue<PlanJob>(QUEUES.plan, { connection });
  return {
    fetch,
    analyse,
    plan,
    enqueueFetch: (videoId: string, priority: number = PRIORITY.pool) =>
      fetch.add("fetch", { videoId }, { ...once(videoId), priority }),
    enqueueAnalyse: (videoId: string) => analyse.add("analyse", { videoId }, once(videoId)),
    // One pending refill per session at a time.
    enqueueRefill: (sessionId: string) =>
      plan.add(
        "plan",
        { sessionId, reason: "refill" },
        { jobId: `refill-${sessionId}`, removeOnComplete: true, removeOnFail: true },
      ),
    close: () => Promise.all([fetch.close(), analyse.close(), plan.close()]),
  };
}
export type Queues = ReturnType<typeof createQueues>;
