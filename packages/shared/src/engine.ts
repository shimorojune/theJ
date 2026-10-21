import type { Button, Vibe } from "./schemas";

const BUTTON_DELTA: Record<Button, Vibe> = {
  hype: { energy: 0.2, valence: 0 },
  chill: { energy: -0.2, valence: 0 },
  brighter: { energy: 0, valence: 0.2 },
  moodier: { energy: 0, valence: -0.2 },
};

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** A button tap moves the goal. */
export function applyButton(goal: Vibe, button: Button): Vibe {
  const d = BUTTON_DELTA[button];
  return { energy: clamp(goal.energy + d.energy), valence: clamp(goal.valence + d.valence) };
}

/** Each played song moves the target one step toward the goal, so changes ramp gradually. */
export function stepToward(target: Vibe, goal: Vibe, step = 0.08): Vibe {
  const move = (from: number, to: number) =>
    Math.abs(to - from) <= step + 1e-9 ? to : from + Math.sign(to - from) * step;
  return { energy: move(target.energy, goal.energy), valence: move(target.valence, goal.valence) };
}

/** Distance between a track and the target. Lower is a better fit. */
export function vibeDistance(a: Vibe, b: Vibe): number {
  return Math.hypot(a.energy - b.energy, a.valence - b.valence);
}

/** What the scorer needs to know about a ready track. */
export type Candidate = {
  videoId: string;
  energy: number;
  valence: number;
  languages: string[];
  wordsPerMin: number | null;
};

export type ScoreContext = {
  target: Vibe;
  /** Languages this session allows. */
  languages: string[];
  /** Desired share of each language, e.g. { hi: 0.5, en: 0.5 }. */
  mix: Record<string, number>;
  /** Share of each language among this session's songs so far (played and lined up). */
  playedShare: Record<string, number>;
  /** Already in this session (played or committed): never repeat. */
  inSession: Set<string>;
  /** The user skipped these recently: leave them out. */
  skipped: Set<string>;
  /** The user heard these in the last day: allowed, but pushed down. */
  heardRecently: Set<string>;
  liked: Set<string>;
  fewerLyrics?: boolean;
  /** Small randomness so two parties with the same vibe don't get identical queues. */
  jitter?: () => number;
};

/** Lower is better. Infinity means "not eligible". */
export function scoreCandidate(c: Candidate, ctx: ScoreContext): number {
  if (ctx.inSession.has(c.videoId) || ctx.skipped.has(c.videoId)) return Infinity;
  if (!c.languages.some((l) => ctx.languages.includes(l))) return Infinity;

  let s = vibeDistance(c, ctx.target);
  if (ctx.heardRecently.has(c.videoId)) s += 0.15;
  if (ctx.liked.has(c.videoId)) s -= 0.08;

  // Keep the language mix near what the user asked for: nudge down a language that's over-played.
  for (const l of c.languages) {
    const over = (ctx.playedShare[l] ?? 0) - (ctx.mix[l] ?? 0);
    if (over > 0.15) s += 0.1 / c.languages.length;
  }

  if (ctx.fewerLyrics) s += (c.wordsPerMin ?? 60) / 600;
  return s + (ctx.jitter?.() ?? Math.random() * 0.04);
}

/** Best `n` eligible candidates, best first. */
export function rank(cands: Candidate[], ctx: ScoreContext, n: number): Candidate[] {
  return cands
    .map((c) => ({ c, s: scoreCandidate(c, ctx) }))
    .filter((x) => Number.isFinite(x.s))
    .sort((a, b) => a.s - b.s)
    .slice(0, n)
    .map((x) => x.c);
}

/** Even split across the session's languages unless the user set a ratio for a pair. */
export function languageMix(languages: string[], hiShare?: number): Record<string, number> {
  if (languages.length === 2 && languages.includes("hi") && hiShare !== undefined) {
    const other = languages.find((l) => l !== "hi") as string;
    return { hi: hiShare, [other]: 1 - hiShare };
  }
  return Object.fromEntries(languages.map((l) => [l, 1 / languages.length]));
}
