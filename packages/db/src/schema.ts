import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const trackStatus = pgEnum("track_status", [
  "new",
  "fetching",
  "fetched",
  "ready",
  "failed",
]);
export const queueState = pgEnum("queue_state", ["planned", "committed", "played", "skipped"]);
export const playEventKind = pgEnum("play_event_kind", ["start", "skip", "like", "complete"]);

/** Keyed by Clerk user id. */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  languages: text("languages").array().notNull().default(["en", "hi"]),
  mixRatio: real("mix_ratio").notNull().default(0.5),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Shared across all users: a song is fetched and analysed once. Features outlive the audio. */
export const tracks = pgTable(
  "tracks",
  {
    videoId: text("video_id").primaryKey(),
    title: text("title").notNull(),
    artist: text("artist").notNull(),
    durationS: integer("duration_s"),
    thumbUrl: text("thumb_url"),
    languages: text("languages").array().notNull().default([]),
    status: trackStatus("status").notNull().default("new"),
    failCount: integer("fail_count").notNull().default(0),
    energy: real("energy"),
    valence: real("valence"),
    tempo: real("tempo"),
    dance: real("dance"),
    speech: real("speech"),
    acoustic: real("acoustic"),
    instrumental: real("instrumental"),
    loudness: real("loudness"),
    wordsPerMin: real("words_per_min"),
    audioKey: text("audio_key"),
    audioBytes: bigint("audio_bytes", { mode: "number" }),
    lastPlayedAt: timestamp("last_played_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tracks_status_idx").on(t.status),
    index("tracks_last_played_idx").on(t.lastPlayedAt),
  ],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  goal: jsonb("goal").notNull(),
  target: jsonb("target").notNull(),
  filters: jsonb("filters").notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const queueItems = pgTable(
  "queue_items",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    position: integer("position").notNull(),
    videoId: text("video_id")
      .notNull()
      .references(() => tracks.videoId),
    state: queueState("state").notNull().default("planned"),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.position] })],
);

export const playEvents = pgTable(
  "play_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    videoId: text("video_id").notNull(),
    event: playEventKind("event").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("play_events_user_at_idx").on(t.userId, t.at)],
);

/** Shared LLM refill cache keyed by (languages, energy bucket, valence bucket, era, filter hash). */
export const suggestions = pgTable("suggestions", {
  bucketKey: text("bucket_key").primaryKey(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
