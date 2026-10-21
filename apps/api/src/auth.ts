import { verifyToken } from "@clerk/backend";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { devAuth, env } from "./env";

export type AuthVars = { Variables: { userId: string } };

/** Verifies the Clerk session JWT from `Authorization: Bearer <token>`. */
export const requireAuth = createMiddleware<AuthVars>(async (c, next) => {
  const devUser = devAuth ? c.req.header("x-dev-user") : undefined;
  if (devUser) {
    c.set("userId", `dev_${devUser}`);
    return next();
  }
  const token = c.req.header("authorization")?.replace(/^Bearer /, "");
  if (!token) throw new HTTPException(401, { message: "missing token" });
  try {
    const claims = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
    c.set("userId", claims.sub);
  } catch {
    throw new HTTPException(401, { message: "invalid token" });
  }
  await next();
});
