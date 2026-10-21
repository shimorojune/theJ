ALTER TABLE "songs" ADD COLUMN "embedding" vector(384);--> statement-breakpoint
ALTER TABLE "songs" ADD COLUMN "embedded_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "songs_embedding_hnsw" ON "songs" USING hnsw ("embedding" vector_cosine_ops);
