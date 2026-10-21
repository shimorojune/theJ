/**
 * Resolve the starter shelf (50 Hindi + English songs), insert them as tracks, queue fetches.
 * Usage: pnpm seed
 */
import { tracks } from "@thej/db";
import { db } from "../lib/db";
import { enqueueFetch, fetchQueue } from "../lib/queues";
import { connection } from "../lib/redis";
import { resolveSong } from "../lib/resolve";
import { STARTER, seedStarter } from "../lib/starter";

const queued = await seedStarter({
  resolve: resolveSong,
  insert: async (t) => {
    await db.insert(tracks).values(t).onConflictDoNothing();
  },
  enqueue: (id) => enqueueFetch(id),
  log: console.log,
});
console.log(`queued ${queued}/${STARTER.length}`);
await fetchQueue.close();
await connection.quit();
process.exit(0);
