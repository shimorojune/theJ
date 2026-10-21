CREATE TYPE "public"."play_event_kind" AS ENUM('start', 'skip', 'like', 'complete');--> statement-breakpoint
CREATE TYPE "public"."queue_state" AS ENUM('planned', 'committed', 'played', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."track_status" AS ENUM('new', 'fetching', 'fetched', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "play_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "play_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"video_id" text NOT NULL,
	"event" "play_event_kind" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queue_items" (
	"session_id" text NOT NULL,
	"position" integer NOT NULL,
	"video_id" text NOT NULL,
	"state" "queue_state" DEFAULT 'planned' NOT NULL,
	CONSTRAINT "queue_items_session_id_position_pk" PRIMARY KEY("session_id","position")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"goal" jsonb NOT NULL,
	"target" jsonb NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"bucket_key" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"video_id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"artist" text NOT NULL,
	"duration_s" integer,
	"thumb_url" text,
	"languages" text[] DEFAULT '{}' NOT NULL,
	"status" "track_status" DEFAULT 'new' NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"energy" real,
	"valence" real,
	"tempo" real,
	"dance" real,
	"speech" real,
	"acoustic" real,
	"instrumental" real,
	"loudness" real,
	"words_per_min" real,
	"audio_key" text,
	"audio_bytes" bigint,
	"last_played_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"languages" text[] DEFAULT '{"en","hi"}' NOT NULL,
	"mix_ratio" real DEFAULT 0.5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_video_id_tracks_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."tracks"("video_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "play_events_user_at_idx" ON "play_events" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "tracks_status_idx" ON "tracks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tracks_last_played_idx" ON "tracks" USING btree ("last_played_at");