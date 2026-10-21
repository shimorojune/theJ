/** BullMQ queue names and job payloads shared by api and workers. */
export const QUEUES = {
  fetch: "fetch",
  analyse: "analyse",
  plan: "plan",
} as const;

export type FetchJob = { videoId: string };
export type AnalyseJob = { videoId: string };
export type PlanJob = { sessionId: string; reason: "event" | "control" | "refill" };

/** BullMQ priority: lower number runs first. */
export const PRIORITY = { playSoon: 1, pool: 10, prefetch: 50 } as const;
