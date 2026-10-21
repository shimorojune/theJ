import { Redis } from "ioredis";

/** Shared Redis client for BullMQ. Workers need maxRetriesPerRequest: null. */
export const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});
