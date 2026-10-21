import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { audio } from "./routes/audio";
import { me } from "./routes/me";
import { sessions } from "./routes/sessions";

export const app = new Hono()
  .use(logger())
  .get("/health", (c) => c.json({ ok: true }))
  .route("/me", me)
  .route("/sessions", sessions)
  .route("/audio", audio)
  .onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

/** Imported by the mobile app and the CLI for the typed Hono RPC client. */
export type AppType = typeof app;
