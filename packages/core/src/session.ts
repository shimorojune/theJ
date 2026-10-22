import { randomUUID } from "node:crypto";
import { audioCache, type Db, playEvents, queueItems, sessions, songs, users } from "@thej/db";
import { applyButton, type Button, stepToward, type Vibe } from "@thej/shared";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { embedText } from "./embed";
import { choose, pickCandidates } from "./pick";
import { mayHavePreview } from "./preview";

/** The phone holds the current song plus the next 2. */
const COMMITTED = 3;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Session = typeof sessions.$inferSelect;
type Song = typeof songs.$inferSelect;
type Cache = typeof audioCache.$inferSelect;

/** A committed song plus what the phone needs to play and mix it. */
export type QueuedSong = Song & {
  ready: boolean;
  bpm: number | null;
  mixInS: number | null;
  mixOutS: number | null;
  audioDurationS: number | null;
  /** The song has a store preview the phone can start on before the full audio is pulled. */
  hasPreview: boolean;
  previewOffsetS: number | null;
};

export type QueueState = {
  sessionId: string;
  goal: Vibe;
  target: Vibe;
  moodText: string;
  committed: QueuedSong[];
  liked: string[];
  /** Committed songs whose audio isn't pulled yet: the caller enqueues stream jobs for them. */
  needsAudio: string[];
  /** Set by a long press: the app should jump straight to this song. */
  skipTo?: string;
};

export type StartOptions = {
  languages?: string[];
  vibe?: Vibe;
  /** The mood in words. Defaults to words derived from the vibe. */
  moodText?: string;
};

const vibeWords = (v: Vibe) =>
  `${v.energy > 0.66 ? "hype dance party" : v.energy > 0.33 ? "warm feel good" : "chill slow mellow"} ${
    v.valence > 0.66 ? "bright happy" : v.valence > 0.33 ? "balanced" : "moody sad emotional"
  }`;

export async function startSession(
  db: Db,
  userId: string,
  opts: StartOptions = {},
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
  const languages = opts.languages ?? user?.languages ?? ["en", "hi"];
  const moodText = opts.moodText?.trim() || vibeWords(goal);
  const moodEmbedding = await embedText(
    `${moodText}${languages.includes("hi") ? " bollywood hindi" : ""}`,
  );
  const id = randomUUID();
  await db.insert(sessions).values({
    id,
    userId,
    goal,
    target: goal,
    filters: { languages },
    moodText,
    moodEmbedding,
  });
  return db.transaction(async (tx) => fill(tx, await lock(tx, id)));
}

export async function getSession(db: Db, sessionId: string): Promise<Session | undefined> {
  const [s] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  return s;
}

export async function getQueue(db: Db, sessionId: string): Promise<QueueState> {
  return db.transaction(async (tx) => fill(tx, await lock(tx, sessionId)));
}

/**
 * The app finished or skipped `songId`. Everything committed up to and including it is done,
 * the target steps toward the goal, and the committed queue is topped back up.
 */
export async function advance(
  db: Db,
  sessionId: string,
  songId: string,
  kind: "skip" | "complete",
): Promise<QueueState> {
  return db.transaction(async (tx) => {
    const s = await lock(tx, sessionId);
    const items = await committedItems(tx, sessionId);
    const idx = items.findIndex((i) => i.songId === songId);
    if (idx === -1) return fill(tx, s);
    for (const [n, item] of items.slice(0, idx + 1).entries()) {
      await tx
        .update(queueItems)
        .set({ state: n === idx && kind === "skip" ? "skipped" : "played" })
        .where(and(eq(queueItems.sessionId, sessionId), eq(queueItems.position, item.position)));
    }
    const target = stepToward(s.target as Vibe, s.goal as Vibe);
    await tx.update(sessions).set({ target }).where(eq(sessions.id, sessionId));
    return fill(tx, { ...s, target });
  });
}

/** A song the streamer couldn't get: drop it from the queue and refill. */
export async function dropSong(db: Db, sessionId: string, songId: string): Promise<QueueState> {
  return db.transaction(async (tx) => {
    const s = await lock(tx, sessionId);
    await tx
      .delete(queueItems)
      .where(
        and(
          eq(queueItems.sessionId, sessionId),
          eq(queueItems.songId, songId),
          eq(queueItems.state, "committed"),
        ),
      );
    return fill(tx, s);
  });
}

/**
 * The mood pad or a button. Tap: the goal moves and committed songs stay, so the change eases in.
 * "Now": the target jumps to the goal and everything after the current song is replaced with
 * the best match, which the app skips to.
 */
export async function control(
  db: Db,
  sessionId: string,
  change: Button | Vibe,
  now: boolean,
): Promise<QueueState> {
  return db.transaction(async (tx) => {
    const s = await lock(tx, sessionId);
    const goal = typeof change === "string" ? applyButton(s.goal as Vibe, change) : change;
    const target = now ? goal : (s.target as Vibe);
    await tx.update(sessions).set({ goal, target }).where(eq(sessions.id, sessionId));
    if (!now) return fill(tx, { ...s, goal, target });

    await dropAfterCurrent(tx, sessionId);
    const next = await fill(tx, { ...s, goal, target }, { preferReady: true });
    return { ...next, skipTo: next.committed[1]?.id };
  });
}

/** Rewrite the mood in words (Ask the DJ, or a saved mood) and re-anchor the search. */
export async function setMood(
  db: Db,
  sessionId: string,
  moodText: string,
  vibe?: Vibe,
): Promise<QueueState> {
  const moodEmbedding = await embedText(moodText);
  return db.transaction(async (tx) => {
    const s = await lock(tx, sessionId);
    const goal = vibe ?? (s.goal as Vibe);
    await tx
      .update(sessions)
      .set({ moodText, moodEmbedding, goal })
      .where(eq(sessions.id, sessionId));
    await dropAfterCurrent(tx, sessionId);
    return fill(tx, { ...s, moodText, moodEmbedding, goal });
  });
}

export async function recordEvent(
  db: Db,
  userId: string,
  sessionId: string,
  songId: string,
  event: "start" | "skip" | "like" | "unlike" | "complete",
) {
  await db.insert(playEvents).values({ userId, sessionId, songId, event });
  if (event === "start") {
    await db
      .update(audioCache)
      .set({ lastUsedAt: new Date() })
      .where(eq(audioCache.songId, songId));
  }
}

export async function endSession(db: Db, sessionId: string) {
  await db.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, sessionId));
}

/** The ~10 songs after the committed ones if nothing changes. A projection, never stored. */
export async function previewPlan(db: Db, sessionId: string, n = 10): Promise<Song[]> {
  return db.transaction(async (tx) => {
    const s = await lock(tx, sessionId);
    const ctx = await context(tx, s);
    const out: string[] = [];
    let target = s.target as Vibe;
    let tempo = ctx.currentTempo;
    for (let i = 0; i < n; i++) {
      target = stepToward(target, s.goal as Vibe);
      const [best] = await pickCandidates(tx as unknown as Db, {
        ...ctx,
        energy: target.energy,
        valence: target.valence,
        currentTempo: tempo,
        exclude: [...ctx.exclude, ...out],
        limit: 1,
      });
      if (!best) break;
      out.push(best.id);
      tempo = best.tempo;
    }
    return songsInOrder(tx, out);
  });
}

/** Songs the user has liked (latest like/unlike wins), newest first. */
export async function likedSongs(db: Db, userId: string, limit = 200): Promise<Song[]> {
  const events = await db
    .select({ songId: playEvents.songId, event: playEvents.event, at: playEvents.at })
    .from(playEvents)
    .where(
      and(
        eq(playEvents.userId, userId),
        isNotNull(playEvents.songId),
        inArray(playEvents.event, ["like", "unlike"]),
      ),
    )
    .orderBy(asc(playEvents.at));
  const liked = new Map<string, Date>();
  for (const e of events) {
    if (!e.songId) continue;
    if (e.event === "like") liked.set(e.songId, e.at);
    else liked.delete(e.songId);
  }
  const ids = [...liked.entries()]
    .sort((a, b) => b[1].getTime() - a[1].getTime())
    .slice(0, limit)
    .map(([id]) => id);
  return songsInOrder(db, ids);
}

/** Newest first; for the home card and the Liked screen. */
export async function recentlyPlayed(db: Db, userId: string, limit = 20): Promise<Song[]> {
  const rows = await db
    .select({ songId: playEvents.songId })
    .from(playEvents)
    .where(
      and(
        eq(playEvents.userId, userId),
        isNotNull(playEvents.songId),
        eq(playEvents.event, "start"),
      ),
    )
    .orderBy(desc(playEvents.at))
    .limit(limit);
  return songsInOrder(db, [...new Set(rows.map((r) => r.songId as string))]);
}

// --- internals ---

async function songsInOrder(conn: Db | Tx, ids: string[]): Promise<Song[]> {
  if (!ids.length) return [];
  const rows = await conn.select().from(songs).where(inArray(songs.id, ids));
  return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is Song => Boolean(r));
}

async function lock(tx: Tx, sessionId: string): Promise<Session> {
  // Serialises concurrent events for one session (a skip and a pad move at the same moment).
  const [s] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for("update");
  if (!s) throw new Error(`no session ${sessionId}`);
  return s;
}

function committedItems(tx: Tx, sessionId: string) {
  return tx
    .select()
    .from(queueItems)
    .where(
      and(
        eq(queueItems.sessionId, sessionId),
        eq(queueItems.state, "committed"),
        isNotNull(queueItems.songId),
      ),
    )
    .orderBy(asc(queueItems.position));
}

async function dropAfterCurrent(tx: Tx, sessionId: string) {
  const [current] = await committedItems(tx, sessionId);
  if (!current) return;
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

async function fill(tx: Tx, s: Session, opts: { preferReady?: boolean } = {}): Promise<QueueState> {
  const items = await committedItems(tx, s.id);
  const missing = COMMITTED - items.length;
  if (missing > 0) {
    const ctx = await context(tx, s);
    const [{ max }] = (await tx
      .select({ max: sql<number>`coalesce(max(${queueItems.position}), -1)` })
      .from(queueItems)
      .where(eq(queueItems.sessionId, s.id))) as [{ max: number }];
    let position = Number(max);
    let target = s.target as Vibe;
    let tempo = ctx.currentTempo;
    const picked: string[] = [];
    for (let i = 0; i < missing; i++) {
      // The first pick is what plays next; prefer songs whose audio is already here.
      const preferReady = opts.preferReady || (items.length === 0 && i === 0);
      const cands = await pickCandidates(tx as unknown as Db, {
        ...ctx,
        energy: target.energy,
        valence: target.valence,
        currentTempo: tempo,
        exclude: [...ctx.exclude, ...picked],
        preferReady,
        limit: 20,
      });
      // The opener draws from a wide band: the same mood should not open the same way twice.
      const best = choose(cands, { jitter: preferReady ? 0.1 : 0.03, preferReady });
      if (!best) break;
      picked.push(best.id);
      position++;
      await tx
        .insert(queueItems)
        .values({ sessionId: s.id, position, songId: best.id, state: "committed" });
      target = stepToward(target, s.goal as Vibe);
      tempo = best.tempo;
    }
  }
  return state(tx, s);
}

async function state(tx: Tx, s: Session): Promise<QueueState> {
  const items = await committedItems(tx, s.id);
  const ids = items.map((i) => i.songId as string);
  const rows = ids.length
    ? await tx
        .select({ song: songs, cache: audioCache })
        .from(songs)
        .leftJoin(audioCache, eq(audioCache.songId, songs.id))
        .where(inArray(songs.id, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.song.id, r]));
  const committed: QueuedSong[] = ids
    .map((id) => byId.get(id))
    .filter((r): r is { song: Song; cache: Cache | null } => Boolean(r))
    .map(({ song, cache }) => ({
      ...song,
      ready: Boolean(cache),
      bpm: cache?.bpm ?? song.tempo,
      mixInS: cache?.mixInS ?? null,
      mixOutS: cache?.mixOutS ?? null,
      audioDurationS: cache?.durationS ?? null,
      hasPreview: mayHavePreview(song.previewUrl),
      previewOffsetS: cache?.previewOffsetS ?? null,
    }));
  const liked = await likedIds(tx, s.userId);
  return {
    sessionId: s.id,
    goal: s.goal as Vibe,
    target: s.target as Vibe,
    moodText: s.moodText ?? "",
    committed,
    liked: committed.map((c) => c.id).filter((id) => liked.has(id)),
    needsAudio: committed.filter((c) => !c.ready).map((c) => c.id),
  };
}

async function likedIds(tx: Tx, userId: string): Promise<Set<string>> {
  const events = await tx
    .select({ songId: playEvents.songId, event: playEvents.event })
    .from(playEvents)
    .where(
      and(
        eq(playEvents.userId, userId),
        isNotNull(playEvents.songId),
        inArray(playEvents.event, ["like", "unlike"]),
      ),
    )
    .orderBy(asc(playEvents.at));
  const liked = new Set<string>();
  for (const e of events) {
    if (!e.songId) continue;
    if (e.event === "like") liked.add(e.songId);
    else liked.delete(e.songId);
  }
  return liked;
}

async function context(tx: Tx, s: Session) {
  const filters = (s.filters ?? {}) as { languages?: string[] };
  const [user] = await tx.select().from(users).where(eq(users.id, s.userId));
  const languages = filters.languages ?? user?.languages ?? ["en", "hi"];
  const monthAgo = new Date(Date.now() - 30 * 86_400_000);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const dayAgo = new Date(Date.now() - 86_400_000);

  const [sessionItems, heard, liked, current] = await Promise.all([
    // Queued in any of this user's moods today, played or not: a restarted mood opens differently.
    tx
      .select({ songId: queueItems.songId })
      .from(queueItems)
      .innerJoin(sessions, eq(sessions.id, queueItems.sessionId))
      .where(
        and(
          eq(sessions.userId, s.userId),
          or(eq(queueItems.sessionId, s.id), gte(sessions.startedAt, dayAgo)),
        ),
      ),
    // Anything started or skipped in the last 30 days stays out: repeats are what bores a room.
    tx
      .select({ songId: playEvents.songId, event: playEvents.event, at: playEvents.at })
      .from(playEvents)
      .where(
        and(
          eq(playEvents.userId, s.userId),
          isNotNull(playEvents.songId),
          inArray(playEvents.event, ["start", "skip"]),
          gte(playEvents.at, monthAgo),
        ),
      ),
    likedIds(tx, s.userId),
    committedItems(tx, s.id).then((items) => items[0]),
  ]);

  let currentTempo: number | null = null;
  if (current?.songId) {
    const [row] = await tx
      .select({ tempo: songs.tempo, bpm: audioCache.bpm })
      .from(songs)
      .leftJoin(audioCache, eq(audioCache.songId, songs.id))
      .where(eq(songs.id, current.songId));
    currentTempo = row?.bpm ?? row?.tempo ?? null;
  }

  // Liked songs come back after a week, so favourites return without the set going stale.
  const exclude = new Set<string>();
  for (const i of sessionItems) if (i.songId) exclude.add(i.songId);
  for (const h of heard) {
    const id = h.songId as string;
    if (liked.has(id) && h.event === "start" && h.at < weekAgo) continue;
    exclude.add(id);
  }
  return {
    moodEmbedding: s.moodEmbedding ?? [],
    languages,
    exclude: [...exclude],
    liked: [...liked],
    currentTempo,
  };
}
