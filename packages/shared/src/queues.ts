/** BullMQ queue names and job payloads shared by api and workers. */
export const QUEUES = {
  fetch: "fetch",
  analyse: "analyse",
  plan: "plan",
  /** On-demand audio: resolve, pull through the home proxy, analyse, serve. */
  stream: "stream",
} as const;

export type FetchJob = { videoId: string };
export type AnalyseJob = { videoId: string };
export type PlanJob = { sessionId: string; reason: "event" | "control" | "refill" };
export type StreamJob = { songId: string };

/** Redis pub/sub channel the streamer announces ready (or failed) audio on. */
export const STREAM_READY_CHANNEL = "stream:ready";
export type StreamReady = { songId: string; ok: boolean; error?: string };

/** BullMQ priority: lower number runs first. */
export const PRIORITY = { playSoon: 1, pool: 10, prefetch: 50 } as const;
