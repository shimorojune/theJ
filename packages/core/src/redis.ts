import { Redis } from "ioredis";

/** BullMQ needs maxRetriesPerRequest: null on every connection it uses. */
export function createRedis(url = process.env.REDIS_URL ?? "redis://localhost:6379") {
  return new Redis(url, { maxRetriesPerRequest: null });
}

/** Pub/sub channel the api's SSE stream listens on. */
export const sessionChannel = (sessionId: string) => `session:${sessionId}`;
