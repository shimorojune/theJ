import { randomUUID } from "node:crypto";
import { type Db, playEvents, queueItems, sessions, tracks, users } from "@thej/db";
import {
  applyButton,
  type Button,
  type Candidate,
  languageMix,
  rank,
  type ScoreContext,
  stepToward,
  type Vibe,
} from "@thej/shared";
import { and, arrayOverlaps, asc, eq, gt, gte, inArray, isNotNull, sql } from "drizzle-orm";

/** The phone holds the current song plus the next 2. */
const COMMITTED = 3;
/** Below this many eligible songs, ask the planner to find more. */
const LOW_POOL = 8;

export type Filters = { languages?: string[]; fewerLyrics?: boolean };
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;
type Session = typeof sessions.$inferSelect;
export type Track = typeof tracks.$inferSelect;

export type QueueState = {
  sessionId: string;
  goal: Vibe;
  target: Vibe;
  committed: Track[];
  /** Few songs left to choose from: the caller should enqueue a refill. */
  lowPool: boolean;
  /** Set by a long press: the app should jump straight to this song. */
  skipTo?: string;
};

export async function startSession(
  db: Db,
  userId: string,
  opts: { languages?: string[]; vibe?: Vibe } = {},
): Promise<QueueState> {
  const [user] = await db
    .insert(users)
    .values({ id: userId, ...(opts.languages ? { languages: opts.languages } : {}) })
    .onConflictDoUpdate({
      target: users.id,
      set: opts.languages ? { languages: opts.languages } : { id: userId },
    })
    .returning();
  const goal = opts.vibe ?? { energy: 0.5, valence: 0.5 };
  const id = randomUUID();
  await db.insert(sessions).values({
    id,
    userId,
    goal,
    target: goal,
    filters: { languages: opts.languages ?? user?.languages },
  });
  return db.transaction(async (tx) => fill(tx, await lock(tx, id)));
}

export async function getSession(db: Db, sessionId: string): Promise<Session | undefined> {
  const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  return s;
}

export async function getQueue(db: Db, sessionId: string): Promise<QueueState> {
  return db.transaction(async (tx) => state(tx, await lock(tx, sessionId)));
}

/**
 * The app finished or skipped `videoId`. Every committed song up to and including it is done,
 * the target steps one notch toward the goal, and the committed queue is topped back up.
 */
export async function advance(
  db: Db,
  sessionId: string,
  videoId: string,
  kind: "skip" | "complete",
): Promise<QueueState> {
  return db.transaction(async (tx) => {
    const s = await lock(tx, sessionId);
    const items = await committedItems(tx, sessionId);
    const idx = items.findIndex((i) => i.videoId === videoId);
    if (idx === -1) return state(tx, s);
    for (const [n, item] of items.slice(0, idx + 1).entries()) {
      const done = n === idx && kind === "skip" ? "skipped" : "played";
      await tx
        .update(queueItems)
        .set({ state: done })
        .where(and(eq(queueItems.sessionId, sessionId), eq(queueItems.position, item.position)));
    }
    const target = stepToward(s.target as Vibe, s.goal as Vibe);
    await tx.update(sessions).set({ target }).where(eq(sessions.id, sessionId));
    return fill(tx, { ...s, target });
  });
}

/**
 * A vibe button. A tap moves the goal and the committed songs stay, so the change eases in.
 * A long press ("now") also jumps the target to the goal and replaces everything after the
 * current song with the best match, which the app skips to.
 */
export async function control(
  db: Db,
  sessionId: string,
  button: Button,
  now: boolean,
): Promise<QueueState> {
  return db.transaction(async (tx) => {
    const s = await lock(tx, sessionId);
    const goal = applyButton(s.goal as Vibe, button);
    const target = now ? goal : (s.target as Vibe);
    await tx.update(sessions).set({ goal, target }).where(eq(sessions.id, sessionId));
    if (!now) return state(tx, { ...s, goal, target });

    const [current] = await committedItems(tx, sessionId);
    if (current) {
      await tx
        .delete(queueItems)
        .where(
          and(
            eq(queueItems.sessionId, sessionId),
            eq(queueItems.state, "committed"),
            gt(queueItems.position, current.position),
          ),
        );
    }
    const next = await fill(tx, { ...s, goal, target });
    return { ...next, skipTo: next.committed[1]?.videoId };
  });
}

/** start / like are recorded; start also marks the song as recently played for the LRU cache. */
export async function recordEvent(
  db: Db,
  userId: string,
  sessionId: string,
  videoId: string,
  event: "start" | "skip" | "like" | "complete",
) {
  await db.insert(playEvents).values({ userId, sessionId, videoId, event });
  if (event === "start") {
    await db.update(tracks).set({ lastPlayedAt: new Date() }).where(eq(tracks.videoId, videoId));
  }
}

export async function endSession(db: Db, sessionId: string) {
  await db.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, sessionId));
}

/** The ~10 songs after the committed ones, if nothing changes. A projection, never stored. */
export async function previewPlan(db: Db, sessionId: string, n = 10): Promise<Track[]> {
  return db.transaction(async (tx) => {
    const s = await lock(tx, sessionId);
    const { ctx, pool } = await context(tx, s);
    const out: Track[] = [];
    let target = ctx.target;
    for (let i = 0; i < n; i++) {
      target = stepToward(target, s.goal as Vibe);
      const [best] = rank(pool.cands, { ...ctx, target, jitter: () => 0 }, 1);
      if (!best) break;
      ctx.inSession.add(best.videoId);
      out.push(pool.byId.get(best.videoId) as Track);
    }
    return out;
  });
}

// --- internals ---

async function lock(tx: Tx, sessionId: string): Promise<Session> {
  // Serialises concurrent events for one session (a skip and a button press at the same moment).
  const [s] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for("update");
  if (!s) throw new Error(`no session ${sessionId}`);
  return s;
}

function committedItems(tx: Conn, sessionId: string) {
  return tx
    .select()
    .from(queueItems)
    .where(and(eq(queueItems.sessionId, sessionId), eq(queueItems.state, "committed")))
    .orderBy(asc(queueItems.position));
}

async function fill(tx: Tx, s: Session): Promise<QueueState> {
  const items = await committedItems(tx, s.id);
  const missing = COMMITTED - items.length;
  if (missing > 0) {
    const { ctx, pool } = await context(tx, s);
    // One at a time, so each pick sees the language balance of the ones before it.
    const picks: Candidate[] = [];
    let total = ctx.inSession.size;
    for (let i = 0; i < missing; i++) {
      const [best] = rank(pool.cands, ctx, 1);
      if (!best) break;
      picks.push(best);
      ctx.inSession.add(best.videoId);
      total++;
      for (const l of Object.keys(ctx.mix)) {
        const had = (ctx.playedShare[l] ?? 0) * (total - 1);
        ctx.playedShare[l] = (had + (best.languages.includes(l) ? 1 : 0)) / total;
      }
    }
    const [{ max }] = (await tx
      .select({ max: sql<number>`coalesce(max(${queueItems.position}), -1)` })
      .from(queueItems)
      .where(eq(queueItems.sessionId, s.id))) as [{ max: number }];
    if (picks.length) {
      await tx.insert(queueItems).values(
        picks.map((p, i) => ({
          sessionId: s.id,
          position: Number(max) + 1 + i,
          videoId: p.videoId,
          state: "committed" as const,
        })),
      );
    }
  }
  return state(tx, s);
}

async function state(tx: Tx, s: Session): Promise<QueueState> {
  const items = await committedItems(tx, s.id);
  const rows = items.length
    ? await tx
        .select()
        .from(tracks)
        .where(
          inArray(
            tracks.videoId,
            items.map((i) => i.videoId),
          ),
        )
    : [];
  const byId = new Map(rows.map((r) => [r.videoId, r]));
  const { ctx, pool } = await context(tx, s);
  const eligible = rank(pool.cands, ctx, LOW_POOL).length;
  return {
    sessionId: s.id,
    goal: s.goal as Vibe,
    target: s.target as Vibe,
    committed: items.map((i) => byId.get(i.videoId)).filter((t): t is Track => Boolean(t)),
    lowPool: eligible < LOW_POOL,
  };
}

async function context(tx: Tx, s: Session) {
  const filters = (s.filters ?? {}) as Filters;
  const [user] = await tx.select().from(users).where(eq(users.id, s.userId));
  const languages = filters.languages ?? user?.languages ?? ["en", "hi"];
  const dayAgo = new Date(Date.now() - 24 * 3600_000);
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000);

  const [rows, sessionItems, events] = await Promise.all([
    tx
      .select()
      .from(tracks)
      .where(
        and(
          eq(tracks.status, "ready"),
          isNotNull(tracks.energy),
          isNotNull(tracks.valence),
          arrayOverlaps(tracks.languages, languages),
        ),
      ),
    tx
      .select({ videoId: queueItems.videoId, state: queueItems.state })
      .from(queueItems)
      .where(eq(queueItems.sessionId, s.id)),
    tx
      .select({ videoId: playEvents.videoId, event: playEvents.event, at: playEvents.at })
      .from(playEvents)
      .where(and(eq(playEvents.userId, s.userId), gte(playEvents.at, weekAgo))),
  ]);

  const byId = new Map(rows.map((r) => [r.videoId, r]));
  // Committed songs count too, so the next pick balances against what's already lined up.
  const played = sessionItems;
  const playedShare: Record<string, number> = {};
  for (const p of played) {
    for (const l of byId.get(p.videoId)?.languages ?? []) {
      playedShare[l] = (playedShare[l] ?? 0) + 1 / played.length;
    }
  }

  const ctx: ScoreContext = {
    target: s.target as Vibe,
    languages,
    mix: languageMix(languages, user?.mixRatio),
    playedShare,
    inSession: new Set(sessionItems.map((i) => i.videoId)),
    skipped: new Set(events.filter((e) => e.event === "skip").map((e) => e.videoId)),
    heardRecently: new Set(
      events.filter((e) => e.event === "start" && e.at >= dayAgo).map((e) => e.videoId),
    ),
    liked: new Set(events.filter((e) => e.event === "like").map((e) => e.videoId)),
    fewerLyrics: filters.fewerLyrics,
  };
  const cands: Candidate[] = rows.map((r) => ({
    videoId: r.videoId,
    energy: r.energy as number,
    valence: r.valence as number,
    languages: r.languages,
    wordsPerMin: r.wordsPerMin,
  }));
  return { ctx, pool: { cands, byId } };
}
