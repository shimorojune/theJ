import { embedTexts } from "@thej/core";
import { songs } from "@thej/db";
import { eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../lib/db";

export { embedTexts };

type Row = { id: string; title: string; artist: string; labels: string[]; era: string | null };

/** What a song "says" in the mood space. Labels carry the playlist and LLM mood words. */
export const songText = (s: Row) =>
  `${s.title} by ${s.artist} · ${s.labels.slice(0, 12).join(" ")}${s.era ? ` · ${s.era}` : ""}`;

/** Embeds songs with no embedding, or tagged since they were last embedded. */
export async function embedPending(log = console.log): Promise<number> {
  let total = 0;
  for (;;) {
    const rows: Row[] = await db
      .select({
        id: songs.id,
        title: songs.title,
        artist: songs.artist,
        labels: songs.labels,
        era: songs.era,
      })
      .from(songs)
      .where(or(isNull(songs.embeddedAt), lt(songs.embeddedAt, songs.taggedAt)))
      .limit(500);
    if (!rows.length) break;
    const vecs = await embedTexts(rows.map(songText));
    for (const [i, r] of rows.entries()) {
      await db
        .update(songs)
        .set({ embedding: vecs[i], embeddedAt: sql`now()` })
        .where(eq(songs.id, r.id));
    }
    total += rows.length;
    log(`embedded ${total}`);
  }
  return total;
}
