import { verifyToken } from "@clerk/backend";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { devAuth, env } from "./env";

export type AuthVars = { Variables: { userId: string } };

/** Verifies the Clerk session JWT from `Authorization: Bearer <token>`. */
export const requireAuth = createMiddleware<AuthVars>(async (c, next) => {
  const devUser = c.req.header("x-dev-user");
  const devToken = c.req.header("x-dev-token");
  const devOk = devAuth || (env.DEV_AUTH_TOKEN !== undefined && devToken === env.DEV_AUTH_TOKEN);
  if (devUser && devOk) {
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
