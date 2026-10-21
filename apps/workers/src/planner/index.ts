import { sessions, tracks, users } from "@thej/db";
import { type PlanJob, PRIORITY, QUEUES } from "@thej/shared";
import { Worker } from "bullmq";
import { and, arrayOverlaps, eq, lt } from "drizzle-orm";
import { db } from "../lib/db";
import { enqueueFetch } from "../lib/queues";
import { connection } from "../lib/redis";

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
