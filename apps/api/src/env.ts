import { z } from "zod";

export const env = z
  .object({
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    CLERK_SECRET_KEY: z.string().default(""),
    AUDIO_URL_SIGNING_SECRET: z.string().min(8),
  })
  .parse(process.env);
