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
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const trackStatus = pgEnum("track_status", [
  "new",
  "fetching",
  "fetched",
  "ready",
  "failed",
]);
export const queueState = pgEnum("queue_state", ["planned", "committed", "played", "skipped"]);
export const playEventKind = pgEnum("play_event_kind", [
  "start",
  "skip",
  "like",
  "unlike",
  "complete",
]);

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

// --- catalog (architecture v3): song descriptions, never audio ---

/** One row per distinct recording, deduplicated by ISRC when known, else by normalised artist + title. */
export const songs = pgTable(
  "songs",
  {
    id: text("id").primaryKey(),
    isrc: text("isrc"),
    title: text("title").notNull(),
    artist: text("artist").notNull(),
    album: text("album"),
    year: integer("year"),
    durationS: integer("duration_s"),
    languages: text("languages").array().notNull().default([]),
    deezerId: text("deezer_id"),
    spotifyId: text("spotify_id"),
    youtubeId: text("youtube_id"),
    previewUrl: text("preview_url"),
    thumbUrl: text("thumb_url"),
    tempo: real("tempo"),
    energy: real("energy"),
    valence: real("valence"),
    dance: real("dance"),
    acoustic: real("acoustic"),
    /** Mood words and playlist-derived labels, lowercased ("sad", "bollywood", "party"). */
    labels: text("labels").array().notNull().default([]),
    /** Era bucket from the LLM or release year: "1990s", "2010s"… */
    era: text("era"),
    /** How many playlists this song appeared in; a cheap popularity signal. */
    sourceCount: integer("source_count").notNull().default(1),
    taggedAt: timestamp("tagged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("songs_isrc_idx").on(t.isrc),
    index("songs_artist_title_idx").on(t.artist, t.title),
    index("songs_youtube_idx").on(t.youtubeId),
  ],
);

export const playlists = pgTable(
  "playlists",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    /** The mood/genre categories this playlist was found under, lowercased. */
    labels: text("labels").array().notNull().default([]),
    trackCount: integer("track_count"),
    crawledAt: timestamp("crawled_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("playlists_source_external_idx").on(t.source, t.externalId)],
);

export const playlistSongs = pgTable(
  "playlist_songs",
  {
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.id),
    songId: text("song_id")
      .notNull()
      .references(() => songs.id),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.playlistId, t.songId] }),
    index("playlist_songs_song_idx").on(t.songId),
  ],
);
