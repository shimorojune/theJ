import { z } from "zod";

export const env = z
  .object({
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    CLERK_SECRET_KEY: z.string().default(""),
    AUDIO_URL_SIGNING_SECRET: z.string().min(8),
    /** Base URL the phone uses for this api; audio URLs are signed against it. */
    PUBLIC_API_URL: z.string().url().default("http://localhost:3000"),
    /** Dev only: accept `x-dev-user: <id>` instead of a Clerk token. Ignored in production. */
    DEV_AUTH: z.enum(["0", "1"]).default("0"),
    /** Lets a dev build skip Clerk against a deployed api: `x-dev-user` + `x-dev-token`. */
    DEV_AUTH_TOKEN: z.string().min(16).optional(),
    /** Where the streamer's files are mounted here, if the path differs from the streamer's view. */
    STREAM_DIR: z.string().optional(),
    NODE_ENV: z.string().default("development"),
  })
  .parse(process.env);

export const devAuth = env.DEV_AUTH === "1" && env.NODE_ENV !== "production";
