import { createQueues, createRedis, sessionChannel } from "@thej/core";
import { createDb } from "@thej/db";
import { env } from "./env";

export const db = createDb(env.DATABASE_URL);
export const redis = createRedis(env.REDIS_URL);
export const queues = createQueues(redis);

type Listener = (message: string) => void;
const subscriber = createRedis(env.REDIS_URL);
const listeners = new Map<string, Set<Listener>>();
subscriber.on("message", (channel: string, message: string) => {
  for (const l of listeners.get(channel) ?? []) l(message);
});

/** One Redis subscription per session channel, fanned out to every open SSE stream. */
export async function subscribe(sessionId: string, listener: Listener): Promise<() => void> {
  const channel = sessionChannel(sessionId);
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
    await subscriber.subscribe(channel);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) {
      listeners.delete(channel);
      void subscriber.unsubscribe(channel);
    }
  };
}

export const publish = (sessionId: string, payload: unknown) =>
  redis.publish(sessionChannel(sessionId), JSON.stringify(payload));
