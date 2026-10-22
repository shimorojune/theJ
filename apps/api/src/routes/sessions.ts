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
  setMood,
  startSession,
} from "@thej/core";
import { ControlRequest, Language, PlayEventKind, Vibe } from "@thej/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type AuthVars, requireAuth } from "../auth";
import { db, publish, queues, subscribe } from "../deps";
import { toQueueEvent, toSong } from "../present";
import { warmPreview } from "./preview";

const StartBody = z.object({
  languages: z.array(Language).min(1).optional(),
  vibe: Vibe.optional(),
  moodText: z.string().max(300).optional(),
});
const EventBody = z.object({ songId: z.string(), event: PlayEventKind });

/** Push the new queue to every open stream and pull audio for anything not ready yet. */
export async function changed(q: QueueState) {
  const event = toQueueEvent(q);
  await publish(q.sessionId, event);
  for (const [i, songId] of q.needsAudio.entries()) {
    await queues.enqueueStream(songId, i + 1);
    // Fetch the preview now, so the phone's request for it is answered from disk.
    void warmPreview(songId).catch(() => {});
  }
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
    const q = await getQueue(db, id);
    const plan = await previewPlan(db, id);
    return c.json({ ...(await changed(q)), upcoming: plan.map(toSong) });
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
        data: JSON.stringify(await changed(await getQueue(db, id))),
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
    const q =
      body.kind === "text"
        ? await setMood(db, id, body.text, body.vibe)
        : await control(db, id, body.kind === "pad" ? body.vibe : body.button, body.now);
    return c.json(await changed(q));
  })
  .post("/:id/events", zValidator("json", EventBody), async (c) => {
    const id = c.req.param("id");
    const userId = c.get("userId");
    await owned(id, userId);
    const { songId, event } = c.req.valid("json");
    await recordEvent(db, userId, id, songId, event);
    if (event === "skip" || event === "complete") {
      return c.json(await changed(await advance(db, id, songId, event)));
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
