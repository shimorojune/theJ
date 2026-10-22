import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
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

/** pgvector column; 384 dims = all-MiniLM-L6-v2. */
export const vector384 = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(384)",
  toDriver: (v) => `[${v.join(",")}]`,
  fromDriver: (v) => JSON.parse(v) as number[],
});

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
  /** The mood in words ("sad nostalgic bollywood"); its embedding anchors the candidate search. */
  moodText: text("mood_text"),
  moodEmbedding: vector384("mood_embedding"),
  /** Artists the listener asked for by name ("more from Justin Bieber"); their songs lead. */
  artists: text("artists").array().notNull().default([]),
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
    /** v2 (tracks table); kept for old rows. */
    videoId: text("video_id"),
    /** v3 catalog song. */
    songId: text("song_id").references(() => songs.id),
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
    videoId: text("video_id"),
    songId: text("song_id"),
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
    key: text("key"),
    scale: text("scale"),
    /** Set when YouTube resolution or pulling failed; the arranger skips these. */
    unavailableAt: timestamp("unavailable_at", { withTimezone: true }),
    energy: real("energy"),
    valence: real("valence"),
    dance: real("dance"),
    acoustic: real("acoustic"),
    /** Mood words and playlist-derived labels, lowercased ("sad", "bollywood", "party"). */
    labels: text("labels").array().notNull().default([]),
    /** Era bucket from the LLM or release year: "1990s", "2010s"… */
    era: text("era"),
    /**
     * Language guessed from labels and script until the tagger reaches the song (see
     * thej_guess_languages in drizzle/0009). Bhojpuri and Haryanvi win over the tagger, which
     * files them under "hi".
     */
    langGuess: text("lang_guess")
      .array()
      .notNull()
      .generatedAlwaysAs(sql`thej_guess_languages(title, artist, labels)`),
    /** A video upload, lofi/slowed re-edit, mashup or jukebox, not a song: never picked. */
    junk: boolean("junk").notNull().generatedAlwaysAs(sql`thej_is_junk(title)`),
    /** How many playlists this song appeared in; a cheap popularity signal. */
    sourceCount: integer("source_count").notNull().default(1),
    taggedAt: timestamp("tagged_at", { withTimezone: true }),
    /** Text embedding of "title by artist · labels · era"; the mood space lives here. */
    embedding: vector384("embedding"),
    embeddedAt: timestamp("embedded_at", { withTimezone: true }),
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

/** Audio pulled on demand for a queued song. Lives in the streamer's temp dir; rows are deleted with the files. */
export const audioCache = pgTable(
  "audio_cache",
  {
    songId: text("song_id")
      .primaryKey()
      .references(() => songs.id),
    path: text("path").notNull(),
    bytes: integer("bytes").notNull(),
    durationS: real("duration_s").notNull(),
    bpm: real("bpm"),
    /** Beat times in seconds, from the analyser. */
    beats: jsonb("beats").$type<number[]>().notNull().default([]),
    beatConfidence: real("beat_confidence"),
    key: text("key"),
    scale: text("scale"),
    /** Where the next song should start coming in, and where this one can be faded out. */
    mixInS: real("mix_in_s"),
    mixOutS: real("mix_out_s"),
    /**
     * Beat length (s) of a grid fitted to the song's onsets over the mix window at each point.
     * Song-wide bpm drifts too far over a 24-beat mix; these hold. Null on older rows.
     */
    mixInBeatS: real("mix_in_beat_s"),
    mixOutBeatS: real("mix_out_beat_s"),
    /**
     * Where the 30-second store preview sits inside this audio, so the phone can start on the
     * preview and swap to the full song at the same moment. Null when the match was weak.
     */
    previewOffsetS: real("preview_offset_s"),
    /** Normalised correlation of that match, 0 to 1. */
    previewMatch: real("preview_match"),
    /**
     * Where this song's stem windows start (s), once split (streamer/stems.py): the mix-in
     * window (drums, other, rest) and the mix-out window (vocals, bass, rest). Null until then.
     */
    stemsInS: real("stems_in_s"),
    stemsOutS: real("stems_out_s"),
    readyAt: timestamp("ready_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    /** Warm-set songs survive the cleanup sweep. */
    pinned: boolean("pinned").notNull().default(false),
  },
  (t) => [index("audio_cache_last_used_idx").on(t.lastUsedAt)],
);
