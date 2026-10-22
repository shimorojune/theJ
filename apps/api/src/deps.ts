import { createQueues, createRedis, dropSong, getQueue, sessionChannel } from "@thej/core";
import { createDb, queueItems } from "@thej/db";
import { STREAM_READY_CHANNEL, type StreamReady } from "@thej/shared";
import { and, eq } from "drizzle-orm";
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

/**
 * The streamer announces pulled (or failed) audio. Push the fresh queue to every session that has
 * that song committed; drop and refill when it failed. Wired by app.ts after the routes exist.
 */
export async function watchStreamReady(onQueue: (sessionId: string) => Promise<void>) {
  await subscriber.subscribe(STREAM_READY_CHANNEL);
  subscriber.on("message", async (channel: string, message: string) => {
    if (channel !== STREAM_READY_CHANNEL) return;
    const msg = JSON.parse(message) as StreamReady;
    const rows = await db
      .selectDistinct({ sessionId: queueItems.sessionId })
      .from(queueItems)
      .where(and(eq(queueItems.songId, msg.songId), eq(queueItems.state, "committed")));
    for (const { sessionId } of rows) {
      if (!msg.ok) await dropSong(db, sessionId, msg.songId).catch(() => {});
      await onQueue(sessionId).catch((e) => console.error("stream-ready push", e));
    }
  });
}
export { getQueue };
