import { songs } from "@thej/db";
import { sql } from "drizzle-orm";
import { embedTexts } from "../catalog/embed";
import { db } from "../lib/db";

/** A JS string[] as a Postgres text[] literal (drizzle would expand it into a row constructor). */
const textArray = (xs: string[]) =>
  xs.length
    ? sql`array[${sql.join(
        xs.map((x) => sql`${x}`),
        sql`, `,
      )}]::text[]`
    : sql`'{}'::text[]`;

/** Where the DJ is heading: a described mood plus the numeric target the pad sets. */
export type Target = {
  /** Free text, e.g. "sad nostalgic bollywood 2000s"; embedded into the mood space. */
  description: string;
  energy: number;
  valence: number;
  languages: string[];
};

export type Candidate = {
  id: string;
  title: string;
  artist: string;
  youtubeId: string | null;
  energy: number | null;
  valence: number | null;
  tempo: number | null;
  era: string | null;
  labels: string[];
  sourceCount: number;
  /** 0 = perfect fit; lower is better. */
  score: number;
};

export type PickContext = {
  target: Target;
  /** Song ids never to return: played or skipped recently, already queued. */
  exclude: Set<string>;
  /** Song ids the user has liked: eligible again, and nudged up. */
  liked: Set<string>;
  /** Tempo of the song playing now, for a mixable next pick. */
  currentTempo?: number | null;
  limit?: number;
};

/**
 * Nearest songs to the target in the mood space, filtered to the session's languages and
 * never-repeat rules, scored on meaning (embedding), vibe (energy/valence) and mixability (tempo).
 */
export async function pickCandidates(ctx: PickContext): Promise<Candidate[]> {
  const [vec] = await embedTexts([ctx.target.description]);
  const v = `[${(vec ?? []).join(",")}]`;
  const limit = ctx.limit ?? 30;
  const exclude = [...ctx.exclude];
  const liked = [...ctx.liked];
  const tempo = ctx.currentTempo ?? null;

  // Tempo term: 0 when within 6% (or a clean half/double), 1 when unknown or far.
  const rows = await db.execute<Candidate>(sql`
    with scored as (
      select id, title, artist, youtube_id as "youtubeId", energy, valence, tempo, era, labels,
             source_count as "sourceCount",
             (embedding <=> ${v}::vector) as sem,
             sqrt(power(coalesce(energy, 0.5) - ${ctx.target.energy}, 2) + power(coalesce(valence, 0.5) - ${ctx.target.valence}, 2)) as vibe,
             case
               when ${tempo}::real is null or tempo is null or tempo = 0 then 0.5
               when abs(tempo / ${tempo}::real - 1) <= 0.06 then 0
               when abs(tempo / ${tempo}::real - 0.5) <= 0.03 or abs(tempo / ${tempo}::real - 2) <= 0.12 then 0.15
               else 1 end as mix,
             case when id = any(${textArray(liked)}) then 1 else 0 end as liked
      from songs
      where embedding is not null
        and languages && ${textArray(ctx.target.languages)}
        and not (id = any(${textArray(exclude)}))
      order by embedding <=> ${v}::vector
      limit 200
    )
    select *, (0.45 * sem + 0.40 * vibe + 0.15 * mix - 0.08 * liked - 0.02 * least(log("sourceCount" + 1), 3)) as score
    from scored
    order by score
    limit ${limit}
  `);
  return (rows as unknown as Candidate[]).map((r) => ({ ...r, score: Number(r.score) }));
}

/** Picks the next song: best candidate with a little randomness so two parties don't match. */
export function choose(cands: Candidate[], jitter = 0.03): Candidate | undefined {
  if (!cands.length) return undefined;
  const best = cands[0] as Candidate;
  const close = cands.filter((c) => c.score - best.score <= jitter);
  return close[Math.floor(Math.random() * close.length)] ?? best;
}
