ALTER TABLE "queue_items" DROP CONSTRAINT "queue_items_video_id_tracks_video_id_fk";
--> statement-breakpoint
ALTER TABLE "play_events" ALTER COLUMN "video_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "queue_items" ALTER COLUMN "video_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "play_events" ADD COLUMN "song_id" text;--> statement-breakpoint
ALTER TABLE "queue_items" ADD COLUMN "song_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "mood_text" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "mood_embedding" vector(384);--> statement-breakpoint
ALTER TABLE "queue_items" ADD CONSTRAINT "queue_items_song_id_songs_id_fk" FOREIGN KEY ("song_id") REFERENCES "public"."songs"("id") ON DELETE no action ON UPDATE no action;