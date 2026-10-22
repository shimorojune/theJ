import { type QueuedSong, type QueueState, signAudioUrl } from "@thej/core";
import type { songs } from "@thej/db";
import type { QueueEvent, QueueTrack } from "@thej/shared";
import { env } from "./env";

type Song = typeof songs.$inferSelect;

const thumb = (s: Song) =>
  s.thumbUrl ??
  (s.youtubeId
    ? `https://i.ytimg.com/vi/${s.youtubeId}/hqdefault.jpg`
    : "https://thej.rraj.dev/art/none.png");

/** A catalog song as the app lists it (queue plan, liked, recent). */
export function toSong(
  s: Song,
): Omit<QueueTrack, "ready" | "mixInS" | "mixOutS" | "bpm" | "audioUrl"> & { bpm: number | null } {
  return {
    songId: s.id,
    title: s.title,
    artist: s.artist,
    durationS: s.durationS ?? 0,
    thumbUrl: thumb(s),
    energy: s.energy,
    valence: s.valence,
    bpm: s.tempo === null ? null : Math.round(s.tempo),
  };
}

export function toQueueTrack(q: QueuedSong): QueueTrack {
  return {
    ...toSong(q),
    durationS: q.audioDurationS ?? q.durationS ?? 0,
    audioUrl: signAudioUrl(env.PUBLIC_API_URL, q.id, env.AUDIO_URL_SIGNING_SECRET),
    ready: q.ready,
    bpm: q.bpm === null ? null : Math.round(q.bpm * 100) / 100,
    mixInS: q.mixInS,
    mixOutS: q.mixOutS,
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
    liked: q.liked,
    moodText: q.moodText,
    goal: q.goal,
    target: q.target,
    ...(q.skipTo ? { skipTo: q.skipTo } : {}),
  };
}
