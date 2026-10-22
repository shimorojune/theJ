import type { Db } from "@thej/db";
import { sql } from "drizzle-orm";

/** A JS string[] as a Postgres text[] literal (drizzle would expand it into a row constructor). */
export const textArray = (xs: string[]) =>
  xs.length
    ? sql`array[${sql.join(
        xs.map((x) => sql`${x}`),
        sql`, `,
      )}]::text[]`
    : sql`'{}'::text[]`;

export const vectorLiteral = (v: number[]) => `[${v.join(",")}]`;

export type Candidate = {
  id: string;
  title: string;
  artist: string;
  energy: number | null;
  valence: number | null;
  tempo: number | null;
  key: string | null;
  scale: string | null;
  era: string | null;
  sourceCount: number;
  ready: boolean;
  /** The song's language (tag, else guess); see songLanguages. */
  langs: string[];
  /** 0 = perfect fit; lower is better. */
  score: number;
};

export type PickContext = {
  /** The mood's embedding (stored on the session). */
  moodEmbedding: number[];
  energy: number;
  valence: number;
  languages: string[];
  /** Never return these: heard recently, skipped, already queued. */
  exclude: string[];
  /** Liked songs are nudged up. */
  liked: string[];
  /** Tempo of the song this pick follows, for a mixable next pick. */
  currentTempo?: number | null;
  /** Key of the song this pick follows, for a harmonic blend (Camelot wheel). */
  currentKey?: { key: string | null; scale: string | null } | null;
  /** Prefer songs whose audio is already pulled (instant start). */
  preferReady?: boolean;
  /** Artists asked for by name, lowercased: their songs join the pool and lead it. */
  artists?: string[];
  limit?: number;
};

/** Hindi as the listener picked it ("Bollywood, indie, Punjabi") also covers Punjabi and Urdu. */
export function allowedLanguages(languages: string[]): string[] {
  return [...new Set(languages.flatMap((l) => (l === "hi" ? ["hi", "pa", "ur"] : [l])))];
}

/**
 * The language the next pick should be in so the set keeps the listener's English/Hindi mix
 * (`hiShare` is the Hindi share they chose). With one language, or none to balance, all of them.
 */
export function nextLanguages(
  languages: string[],
  hiShare: number,
  recent: { hi: number; en: number },
): string[] {
  if (!(languages.includes("hi") && languages.includes("en"))) return languages;
  const owed = hiShare * (recent.hi + recent.en + 1) - recent.hi;
  return [owed >= 0.5 ? "hi" : "en"];
}

/** Count a picked song toward the English/Hindi mix. */
export function countLanguage(recent: { hi: number; en: number }, langs: string[]) {
  if (langs.some((l) => l === "hi" || l === "pa" || l === "ur")) recent.hi++;
  else if (langs.includes("en")) recent.en++;
}

/**
 * Artists named in the listener's words ("more from Justin Bieber", even "justin beiber"),
 * lowercased: credited first artists with a few songs whose name matches a run of one to
 * three words in the text, allowing a typo or two in longer names, or the first name alone.
 */
export async function artistsIn(db: Db, text: string): Promise<string[]> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const grams = new Set<string>();
  for (let n = 1; n <= 3; n++)
    for (let i = 0; i + n <= words.length; i++) grams.add(words.slice(i, i + n).join(" "));
  const tries = [...grams].filter((g) => g.length >= 4);
  if (!tries.length) return [];
  // Only the closest matches: "justin beiber" is Bieber, not every Justin.
  const rows = await db.execute<{ a: string }>(sql`
    select a from (
    select a, m.d, min(m.d) over () as best from artist_names t
    cross join lateral (
      -- A first name alone ("arijit") ranks after any spelling of a full name.
      select min(case when length(g) >= 5 and a like g || ' %' then 2.5 else levenshtein(a, g) end) as d
      from unnest(${textArray(tries)}) g
      where abs(length(g) - length(a)) <= 2 or (length(g) >= 5 and a like g || ' %')
    ) m
    where length(a) >= 4 and n >= 3
      and (m.d <= case when length(a) >= 10 then 2 when length(a) >= 6 then 1 else 0 end or m.d = 2.5)
      and (m.d = 0 or n >= 5)
      and a not in ('love', 'happy', 'chill', 'party', 'dance', 'music', 'songs', 'night', 'summer', 'heart', 'dream', 'bollywood', 'punjabi', 'hindi', 'english', 'more', 'want')
    ) c
    where d = best
    order by length(a) desc
    limit 3`);
  return (rows as unknown as { a: string }[]).map((r) => r.a);
}

/**
 * A song's language: the LLM tag; for untagged songs the language its labels or artist point to
 * (song_langs), else the guess from title script. Bhojpuri and Haryanvi guesses win over a tag
 * (the tagger files them under "hi").
 */
export const songLanguages = sql.raw(`(case
  when s.lang_guess && '{bho,bgc}'::text[] then s.lang_guess
  when s.languages <> '{}'::text[] then s.languages
  else coalesce((select l.langs from song_langs l where l.song_id = s.id), s.lang_guess) end)`);

/**
 * Nearest songs to the mood in the embedding space, in the session's languages, minus the
 * exclusions, scored on meaning, energy/valence distance, tempo mixability, likes and popularity.
 */
export async function pickCandidates(db: Db, ctx: PickContext): Promise<Candidate[]> {
  const rows = await candidates(db, ctx, false);
  // Too few songs with a known language: let unknown ones in rather than run dry.
  return rows.length >= Math.min(5, ctx.limit ?? 30) ? rows : candidates(db, ctx, true);
}

async function candidates(db: Db, ctx: PickContext, unknownLanguage: boolean) {
  const v = vectorLiteral(ctx.moodEmbedding);
  const tempo = ctx.currentTempo ?? null;
  const readyBonus = ctx.preferReady ? 0.02 : 0;
  const langs = textArray(allowedLanguages(ctx.languages));
  const artists = textArray((ctx.artists ?? []).map((a) => `%${a}%`));
  // An HNSW scan hands back its first ef_search (40) neighbours and only then filters, so a
  // language or exclusion filter could leave nothing. Keep scanning until the limit is met
  // (pgvector 0.8 iterative scan), but no further than 4000 rows: past that a rare language
  // would cost seconds, and pickCandidates relaxes instead. Local to the transaction.
  await db.execute(
    sql`select set_config('hnsw.iterative_scan', 'relaxed_order', true),
               set_config('hnsw.ef_search', '100', true),
               set_config('hnsw.max_scan_tuples', '4000', true)`,
  );
  const rows = await db.execute<Candidate>(sql`
    with pool as (
      (select s.id from songs s
       where s.embedding is not null
         and s.unavailable_at is null
         and not s.junk
         and not exists (select 1 from song_skip k where k.song_id = s.id)
         and (${songLanguages} && ${langs} or (${unknownLanguage} and ${songLanguages} = '{}'))
         and not (s.id = any(${textArray(ctx.exclude)}))
       order by s.embedding <=> ${v}::vector
       limit 200)
      union
      -- Asked-for artists in any language: the listener named them.
      (select s.id from songs s
       where cardinality(${artists}) > 0
         and lower(s.artist) like any(${artists})
         and s.unavailable_at is null
         and not s.junk
         and not exists (select 1 from song_skip k where k.song_id = s.id)
         and not (s.id = any(${textArray(ctx.exclude)}))
       order by s.source_count desc
       limit 100)
    ),
    scored as (
      select s.id, s.title, s.artist, s.energy, s.valence, s.tempo, s.key, s.scale, s.era,
             s.source_count as "sourceCount", ${songLanguages} as langs,
             (c.song_id is not null) as ready,
             coalesce(s.embedding <=> ${v}::vector, 1) as sem,
             (cardinality(${artists}) > 0 and lower(s.artist) like any(${artists}))::int as asked,
             sqrt(power(coalesce(s.energy, 0.5) - ${ctx.energy}, 2) + power(coalesce(s.valence, 0.5) - ${ctx.valence}, 2)) as vibe,
             case
               when ${tempo}::real is null or s.tempo is null or s.tempo = 0 then 0.5
               when abs(s.tempo / ${tempo}::real - 1) <= 0.06 then 0
               when abs(s.tempo / ${tempo}::real - 0.5) <= 0.03 or abs(s.tempo / ${tempo}::real - 2) <= 0.12 then 0.15
               else 1 end as mix,
             case when s.id = any(${textArray(ctx.liked)}) then 1 else 0 end as liked
      from pool join songs s using (id)
      left join audio_cache c on c.song_id = s.id
    )
    select *, (0.45 * sem + 0.40 * vibe + 0.15 * mix - 0.08 * liked - 0.5 * asked
               - 0.03 * least(ln("sourceCount" + 1), 3) - ${readyBonus}::real * ready::int) as score
    from scored
    order by score
    limit ${(ctx.limit ?? 30) * 2}
  `);
  // Harmonic mixing, as a DJ does: keys a step apart on the Camelot wheel blend, others clash.
  const from = ctx.currentKey ? camelot(ctx.currentKey.key, ctx.currentKey.scale) : null;
  return (rows as unknown as Candidate[])
    .map((r) => ({
      ...r,
      score: Number(r.score) + 0.06 * keyClash(from, camelot(r.key, r.scale)),
      sourceCount: Number(r.sourceCount),
    }))
    .sort((a, b) => a.score - b.score)
    .slice(0, ctx.limit ?? 30);
}

const PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Camelot wheel position (1-12, minor = A, major = B) of a key like "Bb" / "minor". */
export function camelot(
  key: string | null,
  scale: string | null,
): { n: number; minor: boolean } | null {
  const [, note = "", accidental = ""] = key?.trim().match(/^([A-Ga-g])([#b♯♭]?)/) ?? [];
  const base = PITCH[note.toUpperCase()];
  if (base === undefined || !scale) return null;
  const minor = /^min/i.test(scale);
  let pc = base + (accidental === "#" || accidental === "♯" ? 1 : accidental ? -1 : 0);
  if (minor) pc += 3; // the relative major shares the number
  pc = ((pc % 12) + 12) % 12;
  return { n: ((((7 * pc) % 12) + 7) % 12) + 1, minor };
}

/** 0 for the same key, its relative or a neighbour on the wheel; 0.5 two steps out; else 1. */
export function keyClash(
  a: { n: number; minor: boolean } | null,
  b: { n: number; minor: boolean } | null,
): number {
  if (!a || !b) return 0.5;
  const d = Math.min((a.n - b.n + 12) % 12, (b.n - a.n + 12) % 12);
  if (d === 0) return 0;
  if (d === 1 && a.minor === b.minor) return 0;
  return d === 2 && a.minor === b.minor ? 0.5 : 1;
}

/**
 * A random candidate from the band near the best, so two sessions with the same mood don't
 * match. With `preferReady`, a song whose audio is already here wins within that band (it
 * starts instantly) but never over a clearly better fit outside it.
 */
export function choose(
  cands: Candidate[],
  opts: { jitter?: number; preferReady?: boolean } = {},
): Candidate | undefined {
  const best = cands[0];
  if (!best) return undefined;
  const close = cands.filter((c) => c.score - best.score <= (opts.jitter ?? 0.03));
  const ready = opts.preferReady ? close.filter((c) => c.ready) : [];
  const pool = ready.length ? ready : close;
  return pool[Math.floor(Math.random() * pool.length)] ?? best;
}
