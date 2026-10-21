CREATE TABLE "playlist_songs" (
	"playlist_id" text NOT NULL,
	"song_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "playlist_songs_playlist_id_song_id_pk" PRIMARY KEY("playlist_id","song_id")
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"track_count" integer,
	"crawled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "songs" (
	"id" text PRIMARY KEY NOT NULL,
	"isrc" text,
	"title" text NOT NULL,
	"artist" text NOT NULL,
	"album" text,
	"year" integer,
	"duration_s" integer,
	"languages" text[] DEFAULT '{}' NOT NULL,
	"deezer_id" text,
	"spotify_id" text,
	"youtube_id" text,
	"preview_url" text,
	"thumb_url" text,
	"tempo" real,
	"energy" real,
	"valence" real,
	"dance" real,
	"acoustic" real,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"era" text,
	"source_count" integer DEFAULT 1 NOT NULL,
	"tagged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playlist_songs" ADD CONSTRAINT "playlist_songs_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_songs" ADD CONSTRAINT "playlist_songs_song_id_songs_id_fk" FOREIGN KEY ("song_id") REFERENCES "public"."songs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playlist_songs_song_idx" ON "playlist_songs" USING btree ("song_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playlists_source_external_idx" ON "playlists" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "songs_isrc_idx" ON "songs" USING btree ("isrc");--> statement-breakpoint
CREATE INDEX "songs_artist_title_idx" ON "songs" USING btree ("artist","title");--> statement-breakpoint
CREATE INDEX "songs_youtube_idx" ON "songs" USING btree ("youtube_id");