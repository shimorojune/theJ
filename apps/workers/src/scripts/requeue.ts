/** Retries failed fetch/analyse jobs and queues analysis for fetched tracks. */
import { tracks } from "@thej/db";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { analyseQueue, enqueueAnalyse, fetchQueue } from "../lib/queues";
import { connection } from "../lib/redis";

await fetchQueue.retryJobs({ state: "failed" });
await analyseQueue.retryJobs({ state: "failed" });
const fetched = await db
  .select({ id: tracks.videoId })
  .from(tracks)
  .where(eq(tracks.status, "fetched"));
for (const t of fetched) await enqueueAnalyse(t.id);
console.log(`retried failed jobs; ${fetched.length} fetched tracks queued for analysis`);
await Promise.all([fetchQueue.close(), analyseQueue.close()]);
await connection.quit();
process.exit(0);
