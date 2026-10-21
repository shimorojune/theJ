import { z } from "zod";

/** YouTube video id, the primary key for every track. */
export const VideoId = z.string().regex(/^[A-Za-z0-9_-]{11}$/);

export const Language = z.enum(["en", "hi", "ja"]);
export type Language = z.infer<typeof Language>;

export const TrackStatus = z.enum(["new", "fetching", "fetched", "ready", "failed"]);
export type TrackStatus = z.infer<typeof TrackStatus>;

/** The two axes the 4 buttons move. Both 0..1. */
export const Vibe = z.object({
  energy: z.number().min(0).max(1),
  valence: z.number().min(0).max(1),
});
export type Vibe = z.infer<typeof Vibe>;

export const Button = z.enum(["hype", "chill", "brighter", "moodier"]);
export type Button = z.infer<typeof Button>;

export const ControlRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("button"), button: Button, now: z.boolean().default(false) }),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(500) }),
]);
export type ControlRequest = z.infer<typeof ControlRequest>;

export const PlayEventKind = z.enum(["start", "skip", "like", "complete"]);
export const PlayEvent = z.object({
  sessionId: z.string(),
  videoId: VideoId,
  event: PlayEventKind,
});
export type PlayEvent = z.infer<typeof PlayEvent>;

export const QueueTrack = z.object({
  videoId: VideoId,
  title: z.string(),
  artist: z.string(),
  durationS: z.number(),
  thumbUrl: z.string().url(),
  audioUrl: z.string().url(),
});
export type QueueTrack = z.infer<typeof QueueTrack>;

/** SSE payload whenever the committed queue changes: the current song plus the next 2. */
export const QueueEvent = z.object({
  sessionId: z.string(),
  committed: z.array(QueueTrack).max(3),
});
export type QueueEvent = z.infer<typeof QueueEvent>;
