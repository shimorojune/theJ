import { songs } from "@thej/db";
import { eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../lib/db";
import { sleep } from "./normalize";

/**
 * LLM pass for what the sources don't give: language, era, mood words, a first energy/valence guess.
 * 25 songs per call on a free OpenRouter model; JSON out, validated, bad rows skipped.
 */
const MODELS = (
  process.env.LLM_TAG_MODEL ??
  "minimax/minimax-m3.1-flash:free,nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-26b-a4b-it:free"
).split(",");
let modelIdx = 0;
/** Reasoning models spend their budget thinking; keep batches small and leave room for the answer. */
const BATCH = 15;

const Tag = z.object({
  i: z.number().int(),
  language: z.array(z.string().length(2)).max(3),
  era: z.string().regex(/^\d{4}s$/),
  mood: z.array(z.string().min(2).max(24)).min(1).max(5),
  energy: z.number().min(0).max(1),
  valence: z.number().min(0).max(1),
});
const Tags = z.array(Tag);

type Row = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  year: number | null;
  labels: string[];
};

export async function tagBatch(rows: Row[]): Promise<number> {
  const list = rows
    .map(
      (r, i) =>
        `${i}. "${r.title}" by ${r.artist}${r.album ? ` (album: ${r.album})` : ""}${r.year ? `, ${r.year}` : ""}; seen in: ${r.labels.slice(0, 5).join(", ") || "n/a"}`,
    )
    .join("\n");
  const prompt = `You tag songs for a party DJ. For each numbered song return one JSON object:
{"i": <number>, "language": [ISO 639-1 codes of the sung language(s), e.g. ["hi"], ["en"], ["hi","en"], ["pa"]], "era": "<decade like 2010s>", "mood": [3 to 5 lowercase mood words, e.g. "sad", "romantic", "dance", "nostalgic", "chill", "hype", "devotional"], "energy": 0-1, "valence": 0-1 (0 = dark/sad, 1 = bright/happy)}
Return ONLY a JSON array, no prose.

Songs:
${list}`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODELS[modelIdx % MODELS.length],
      messages: [{ role: "user", content: prompt }],
      max_tokens: 8000,
      temperature: 0.2,
      reasoning: { effort: "low" },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await res.json()) as {
    error?: { message: string };
    choices?: { message: { content: string | null }; finish_reason?: string }[];
  };
  if (body.error || !body.choices?.[0]) {
    modelIdx++;
    throw new Error(`openrouter: ${body.error?.message ?? "no choices"}`);
  }
  const text = body.choices[0].message.content;
  if (!text) {
    modelIdx++;
    throw new Error(`openrouter: empty content (${body.choices[0].finish_reason ?? "?"})`);
  }
  const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  const parsed = Tags.safeParse(JSON.parse(json));
  if (!parsed.success) throw new Error(`tag parse: ${parsed.error.issues[0]?.message}`);

  let n = 0;
  for (const t of parsed.data) {
    const row = rows[t.i];
    if (!row) continue;
    await db
      .update(songs)
      .set({
        languages: t.language.map((l) => l.toLowerCase()),
        era: t.era,
        energy: t.energy,
        valence: t.valence,
        labels: sql`(select array_agg(distinct l) from unnest(${songs.labels} || array[${sql.join(
          t.mood.map((m) => sql`${m.toLowerCase()}`),
          sql`, `,
        )}]::text[]) as l)`,
        taggedAt: new Date(),
      })
      .where(eq(songs.id, row.id));
    n++;
  }
  return n;
}

/** Tags every untagged song, 25 at a time, until none are left or `max` is reached. */
export async function tagUntagged(max = Infinity, log = console.log): Promise<number> {
  let total = 0;
  while (total < max) {
    const rows = await db
      .select({
        id: songs.id,
        title: songs.title,
        artist: songs.artist,
        album: songs.album,
        year: songs.year,
        labels: songs.labels,
      })
      .from(songs)
      .where(isNull(songs.taggedAt))
      .limit(BATCH);
    if (!rows.length) break;
    try {
      const n = await tagBatch(rows);
      total += n;
      if (n < rows.length) {
        // Mark the misses so we don't loop on them forever; a later pass can retry.
        const done = new Set<string>();
        for (const r of rows) {
          const [s] = await db.select({ t: songs.taggedAt }).from(songs).where(eq(songs.id, r.id));
          if (s?.t) done.add(r.id);
        }
        for (const r of rows)
          if (!done.has(r.id))
            await db
              .update(songs)
              .set({ taggedAt: new Date(0) })
              .where(eq(songs.id, r.id));
      }
      log(`tagged ${total}`);
    } catch (e) {
      log(`tag batch failed: ${(e as Error).message}`);
      await sleep(5000);
    }
    await sleep(1000);
  }
  return total;
}
