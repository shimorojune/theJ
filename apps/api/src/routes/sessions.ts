import { zValidator } from "@hono/zod-validator";
import {
  advance,
  control,
  endSession,
  getQueue,
  getSession,
  previewPlan,
  type QueueState,
  recordEvent,
  startSession,
} from "@thej/core";
import { ControlRequest, Language, PlayEventKind, Vibe, VideoId } from "@thej/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type AuthVars, requireAuth } from "../auth";
import { db, publish, queues, subscribe } from "../deps";
import { toQueueEvent, toQueueTrack } from "../present";

const StartBody = z.object({
  languages: z.array(Language).min(1).optional(),
  vibe: Vibe.optional(),
});
const EventBody = z.object({ videoId: VideoId, event: PlayEventKind });

/** Push the new queue to every open stream, and ask the planner for more songs if needed. */
async function changed(q: QueueState) {
  const event = toQueueEvent(q);
  await publish(q.sessionId, event);
  if (q.lowPool) await queues.enqueueRefill(q.sessionId);
  return event;
}

async function owned(sessionId: string, userId: string) {
  const s = await getSession(db, sessionId);
  if (!s || s.userId !== userId) throw new HTTPException(404, { message: "no such session" });
  if (s.endedAt) throw new HTTPException(410, { message: "session ended" });
  return s;
}

export const sessions = new Hono<AuthVars>()
  .use(requireAuth)
  .post("/", zValidator("json", StartBody), async (c) => {
    const q = await startSession(db, c.get("userId"), c.req.valid("json"));
    return c.json(await changed(q), 201);
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    await owned(id, c.get("userId"));
    const [q, plan] = await Promise.all([getQueue(db, id), previewPlan(db, id)]);
    return c.json({ ...toQueueEvent(q), upcoming: plan.map(toQueueTrack) });
  })
  .get("/:id/stream", async (c) => {
    const id = c.req.param("id");
    await owned(id, c.get("userId"));
    return streamSSE(c, async (stream) => {
      const unsubscribe = await subscribe(id, (data) => {
        void stream.writeSSE({ event: "queue", data });
      });
      await stream.writeSSE({
        event: "queue",
        data: JSON.stringify(toQueueEvent(await getQueue(db, id))),
      });
      // Keep proxies from closing an idle stream.
      while (!stream.aborted) {
        await stream.sleep(25_000);
        await stream.writeSSE({ event: "ping", data: "" });
      }
      unsubscribe();
    });
  })
  .post("/:id/control", zValidator("json", ControlRequest), async (c) => {
    const id = c.req.param("id");
    await owned(id, c.get("userId"));
    const body = c.req.valid("json");
    if (body.kind === "text") {
      return c.json({ error: "text requests arrive with the LLM layer (build step 4)" }, 501);
    }
    return c.json(await changed(await control(db, id, body.button, body.now)));
  })
  .post("/:id/events", zValidator("json", EventBody), async (c) => {
    const id = c.req.param("id");
    const userId = c.get("userId");
    await owned(id, userId);
    const { videoId, event } = c.req.valid("json");
    await recordEvent(db, userId, id, videoId, event);
    if (event === "skip" || event === "complete") {
      return c.json(await changed(await advance(db, id, videoId, event)));
    }
    // like / unlike: answer with the queue so the app can show the new state.
    return c.json(toQueueEvent(await getQueue(db, id)));
  })
  .post("/:id/end", async (c) => {
    const id = c.req.param("id");
    await owned(id, c.get("userId"));
    await endSession(db, id);
    return c.body(null, 204);
  });
