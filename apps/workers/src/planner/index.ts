import { createHash } from "node:crypto";
import { sessions, tracks, users } from "@thej/db";
import { type PlanJob, PRIORITY, QUEUES } from "@thej/shared";
import { Worker } from "bullmq";
import { and, arrayOverlaps, eq, lt } from "drizzle-orm";
import { db } from "../lib/db";
import { enqueueFetch } from "../lib/queues";
import { connection } from "../lib/redis";
import { resolveSong } from "../lib/resolve";
import { STARTER, seedStarter } from "../lib/starter";

/**
 * Refill: a session is running low on ready songs. For now, fetch known-but-unfetched tracks in
 * the session's languages. TODO(build step 4): Last.fm similar/tag charts and LLM suggestions.
 */
const worker = new Worker<PlanJob>(
  QUEUES.plan,
  async (job) => {
    const [s] = await db.select().from(sessions).where(eq(sessions.id, job.data.sessionId));
    if (!s) return { skipped: "no session" };
    const [user] = await db.select().from(users).where(eq(users.id, s.userId));
    const languages = (s.filters as { languages?: string[] })?.languages ??
      user?.languages ?? ["en", "hi"];
    const unfetched = await db
      .select({ videoId: tracks.videoId })
      .from(tracks)
      .where(
        and(
          eq(tracks.status, "new"),
          lt(tracks.failCount, 3),
          arrayOverlaps(tracks.languages, languages),
        ),
      )
      .limit(10);
    for (const t of unfetched) await enqueueFetch(t.videoId, PRIORITY.pool);
    return { queued: unfetched.length };
  },
  { connection, concurrency: 4 },
);

worker.on("completed", (job, res) =>
  console.log(`plan ${job.data.sessionId} (${job.data.reason})`, res),
);
worker.on("failed", (job, err) =>
  console.error(`plan failed ${job?.data.sessionId}: ${err.message}`),
);
console.log("planner worker up");

// Seed the starter shelf once per version of the list: resolving is idempotent (tracks keyed by
// video id, fetch jobs keyed by video id), so a rerun only adds what's new.
const STARTER_VERSION = `starter:seeded:${createHash("sha1").update(JSON.stringify(STARTER)).digest("hex").slice(0, 12)}`;
if (!(await connection.get(STARTER_VERSION))) {
  console.log(`seeding the starter shelf (${STARTER.length} songs)`);
  const queued = await seedStarter({
    resolve: resolveSong,
    insert: async (t) => {
      await db.insert(tracks).values(t).onConflictDoNothing();
    },
    enqueue: (id) => enqueueFetch(id, PRIORITY.prefetch),
  });
  await connection.set(STARTER_VERSION, String(queued));
  console.log(`starter shelf: ${queued} songs resolved and queued`);
}
