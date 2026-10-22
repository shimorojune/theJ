import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { db, getQueue, watchStreamReady } from "./deps";
import { audio } from "./routes/audio";
import { lab } from "./routes/lab";
import { me } from "./routes/me";
import { preview } from "./routes/preview";
import { changed, sessions } from "./routes/sessions";

export const app = new Hono()
  .use(logger())
  // Catalog counts too, so a deploy can be checked from outside without a login.
  .get("/health", async (c) => {
    const [row] = await db.execute<{
      songs: number;
      embedded: number;
      tagged: number;
      cached: number;
    }>(sql`
      select (select count(*)::int from songs) as songs,
             (select count(*)::int from songs where embedding is not null) as embedded,
             (select count(*)::int from songs where tagged_at is not null) as tagged,
             (select count(*)::int from audio_cache) as cached`);
    return c.json({ ok: true, catalog: row });
  })
  .route("/me", me)
  .route("/sessions", sessions)
  .route("/audio", audio)
  .route("/preview", preview)
  .route("/lab", lab)
  .onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

void watchStreamReady(async (sessionId) => {
  await changed(await getQueue(db, sessionId));
});

/** Imported by the mobile app and the CLI for the typed Hono RPC client. */
export type AppType = typeof app;
