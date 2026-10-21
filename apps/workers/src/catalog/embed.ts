import { pipeline } from "@huggingface/transformers";
import { songs } from "@thej/db";
import { eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../lib/db";

/** all-MiniLM-L6-v2, 384 dims, runs on the CPU: ~2,000 songs a second once loaded. */
let model: Promise<Awaited<ReturnType<typeof pipeline>>> | undefined;
const load = () =>
  (model ??= pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "fp32" }));

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const embed = (await load()) as unknown as (
    input: string[],
    opts: { pooling: "mean"; normalize: boolean },
  ) => Promise<{ data: Float32Array; dims: number[] }>;
  const out = await embed(texts, { pooling: "mean", normalize: true });
  const data = out.data as Float32Array;
  const dims = out.dims[1] as number;
  return texts.map((_, i) => Array.from(data.slice(i * dims, (i + 1) * dims)));
}

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
