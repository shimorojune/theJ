import { type QueueState, signAudioUrl, type Track } from "@thej/core";
import type { QueueEvent, QueueTrack } from "@thej/shared";
import { env } from "./env";

const thumb = (t: Track) => t.thumbUrl ?? `https://i.ytimg.com/vi/${t.videoId}/hqdefault.jpg`;

export function toQueueTrack(
  t: Track,
): QueueTrack & { energy: number | null; valence: number | null; tempo: number | null } {
  return {
    videoId: t.videoId,
    title: t.title,
    artist: t.artist,
    durationS: t.durationS ?? 0,
    thumbUrl: thumb(t),
    audioUrl: signAudioUrl(env.PUBLIC_API_URL, t.videoId, env.AUDIO_URL_SIGNING_SECRET),
    energy: t.energy,
    valence: t.valence,
    tempo: t.tempo === null ? null : Math.round(t.tempo),
  };
}

export function toQueueEvent(q: QueueState): QueueEvent & {
  goal: QueueState["goal"];
  target: QueueState["target"];
  skipTo?: string;
} {
  return {
    sessionId: q.sessionId,
    committed: q.committed.map(toQueueTrack),
    goal: q.goal,
    target: q.target,
    ...(q.skipTo ? { skipTo: q.skipTo } : {}),
  };
}
