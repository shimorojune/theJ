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
  era: string | null;
  sourceCount: number;
  ready: boolean;
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
  /** Tempo of the song playing now, for a mixable next pick. */
  currentTempo?: number | null;
  /** Prefer songs whose audio is already pulled (instant start). */
  preferReady?: boolean;
  limit?: number;
};

/**
 * Nearest songs to the mood in the embedding space, in the session's languages, minus the
 * exclusions, scored on meaning, energy/valence distance, tempo mixability, likes and popularity.
 */
export async function pickCandidates(db: Db, ctx: PickContext): Promise<Candidate[]> {
  const v = vectorLiteral(ctx.moodEmbedding);
  const tempo = ctx.currentTempo ?? null;
  const readyBonus = ctx.preferReady ? 0.02 : 0;
  const rows = await db.execute<Candidate>(sql`
    with scored as (
      select s.id, s.title, s.artist, s.energy, s.valence, s.tempo, s.era, s.source_count as "sourceCount",
             (c.song_id is not null) as ready,
             (s.embedding <=> ${v}::vector) as sem,
             sqrt(power(coalesce(s.energy, 0.5) - ${ctx.energy}, 2) + power(coalesce(s.valence, 0.5) - ${ctx.valence}, 2)) as vibe,
             case
               when ${tempo}::real is null or s.tempo is null or s.tempo = 0 then 0.5
               when abs(s.tempo / ${tempo}::real - 1) <= 0.06 then 0
               when abs(s.tempo / ${tempo}::real - 0.5) <= 0.03 or abs(s.tempo / ${tempo}::real - 2) <= 0.12 then 0.15
               else 1 end as mix,
             case when s.id = any(${textArray(ctx.liked)}) then 1 else 0 end as liked
      from songs s
      left join audio_cache c on c.song_id = s.id
      where s.embedding is not null
        and s.unavailable_at is null
        and (s.languages && ${textArray(ctx.languages)} or s.languages = '{}')
        and not (s.id = any(${textArray(ctx.exclude)}))
      order by s.embedding <=> ${v}::vector
      limit 200
    )
    select *, (0.45 * sem + 0.40 * vibe + 0.15 * mix - 0.08 * liked
               - 0.03 * least(ln("sourceCount" + 1), 3) - ${readyBonus}::real * ready::int) as score
    from scored
    order by score
    limit ${ctx.limit ?? 30}
  `);
  return (rows as unknown as Candidate[]).map((r) => ({
    ...r,
    score: Number(r.score),
    sourceCount: Number(r.sourceCount),
  }));
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
