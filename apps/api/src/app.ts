import { Hono } from "hono";
import { logger } from "hono/logger";
import { sessions } from "./routes/sessions";

export const app = new Hono()
  .use(logger())
  .get("/health", (c) => c.json({ ok: true }))
  .route("/sessions", sessions);

/** Imported by the mobile app for the typed Hono RPC client. */
export type AppType = typeof app;
