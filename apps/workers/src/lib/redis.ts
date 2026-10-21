import { createRedis } from "@thej/core";

/** Shared Redis client for BullMQ workers and queues. */
export const connection = createRedis();
