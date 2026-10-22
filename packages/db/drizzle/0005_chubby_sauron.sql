CREATE TABLE "audio_cache" (
	"song_id" text PRIMARY KEY NOT NULL,
	"path" text NOT NULL,
	"bytes" integer NOT NULL,
	"duration_s" real NOT NULL,
	"bpm" real,
	"beats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"beat_confidence" real,
	"key" text,
	"scale" text,
	"mix_in_s" real,
	"mix_out_s" real,
	"ready_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "songs" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "songs" ADD COLUMN "scale" text;--> statement-breakpoint
ALTER TABLE "songs" ADD COLUMN "unavailable_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audio_cache" ADD CONSTRAINT "audio_cache_song_id_songs_id_fk" FOREIGN KEY ("song_id") REFERENCES "public"."songs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audio_cache_last_used_idx" ON "audio_cache" USING btree ("last_used_at");