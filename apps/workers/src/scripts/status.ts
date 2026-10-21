/** Pipeline progress: tracks per status, plus the newest ready ones. */
import { tracks } from "@thej/db";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../lib/db";

const counts = await db
  .select({ status: tracks.status, n: sql<number>`count(*)::int` })
  .from(tracks)
  .groupBy(tracks.status);
console.table(counts);

const ready = await db
  .select({
    song: sql<string>`${tracks.artist} || ' – ' || ${tracks.title}`,
    energy: tracks.energy,
    valence: tracks.valence,
    bpm: sql<number>`round(${tracks.tempo})::int`,
    wpm: tracks.wordsPerMin,
    mb: sql<number>`round(${tracks.audioBytes} / 1e6, 1)`,
  })
  .from(tracks)
  .where(eq(tracks.status, "ready"))
  .orderBy(desc(tracks.energy))
  .limit(60);
console.table(ready);
process.exit(0);
