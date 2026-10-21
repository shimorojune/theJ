import { zValidator } from "@hono/zod-validator";
import { users } from "@thej/db";
import { Language } from "@thej/shared";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVars, requireAuth } from "../auth";
import { db } from "../deps";

const Prefs = z.object({
  languages: z.array(Language).min(1).optional(),
  /** Share of Hindi when both Hindi and another language are on. */
  mixRatio: z.number().min(0).max(1).optional(),
});

export const me = new Hono<AuthVars>()
  .use(requireAuth)
  .get("/", async (c) => {
    const id = c.get("userId");
    const [u] = await db
      .insert(users)
      .values({ id })
      .onConflictDoUpdate({ target: users.id, set: { id } })
      .returning();
    return c.json(u);
  })
  .put("/", zValidator("json", Prefs), async (c) => {
    const id = c.get("userId");
    const prefs = c.req.valid("json");
    const [u] = await db
      .insert(users)
      .values({ id, ...prefs })
      .onConflictDoUpdate({
        target: users.id,
        set: prefs.languages || prefs.mixRatio !== undefined ? prefs : { id },
      })
      .returning();
    return c.json(u);
  });
