import { zValidator } from "@hono/zod-validator";
import { ControlRequest, PlayEvent } from "@thej/shared";
import { Hono } from "hono";
import { type AuthVars, requireAuth } from "../auth";

// TODO(build step 2): persist sessions, enqueue plan jobs, stream queue changes over SSE.
export const sessions = new Hono<AuthVars>()
  .use(requireAuth)
  .post("/", (c) => c.json({ sessionId: crypto.randomUUID(), userId: c.get("userId") }, 201))
  .post("/:id/control", zValidator("json", ControlRequest), (c) =>
    c.json({ accepted: c.req.valid("json").kind }, 202),
  )
  .post("/:id/events", zValidator("json", PlayEvent), (c) => c.body(null, 204));
