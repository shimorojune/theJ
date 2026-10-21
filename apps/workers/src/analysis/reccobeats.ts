import { readFile } from "node:fs/promises";
import { z } from "zod";

const BASE = process.env.RECCOBEATS_BASE_URL ?? "https://api.reccobeats.com";

const Features = z.object({
  acousticness: z.number(),
  danceability: z.number(),
  energy: z.number(),
  instrumentalness: z.number(),
  liveness: z.number(),
  loudness: z.number(),
  speechiness: z.number(),
  tempo: z.number(),
  valence: z.number(),
});
export type Features = z.infer<typeof Features>;

export class RateLimited extends Error {
  constructor(readonly retryAfterS: number) {
    super(`ReccoBeats rate limited, retry after ${retryAfterS}s`);
  }
}

/** POST /v1/analysis/audio-features with the clip as multipart `audioFile`. No auth needed. */
export async function extractFeatures(clipPath: string): Promise<Features> {
  const form = new FormData();
  form.append(
    "audioFile",
    new Blob([await readFile(clipPath)], { type: "audio/mpeg" }),
    "clip.mp3",
  );
  const res = await fetch(`${BASE}/v1/analysis/audio-features`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 429) throw new RateLimited(Number(res.headers.get("retry-after") ?? 60));
  if (!res.ok) throw new Error(`ReccoBeats ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Features.parse(await res.json());
}
