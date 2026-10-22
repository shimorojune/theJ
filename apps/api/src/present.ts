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
): Omit<
  QueueTrack,
  | "ready"
  | "mixInS"
  | "mixOutS"
  | "mixInBeatS"
  | "mixOutBeatS"
  | "bpm"
  | "audioUrl"
  | "previewUrl"
  | "previewOffsetS"
  | "stems"
> & { bpm: number | null } {
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

const stemUrl = (songId: string, part: string) =>
  signAudioUrl(
    env.PUBLIC_API_URL,
    `${songId}/${part}`,
    env.AUDIO_URL_SIGNING_SECRET,
    6 * 3600,
    "stems",
  );

const stemUrls = (songId: string) => ({
  in: {
    drums: stemUrl(songId, "in-drums"),
    other: stemUrl(songId, "in-other"),
    rest: stemUrl(songId, "in-rest"),
  },
  out: {
    vocals: stemUrl(songId, "out-vocals"),
    bass: stemUrl(songId, "out-bass"),
    rest: stemUrl(songId, "out-rest"),
  },
});

export function toQueueTrack(q: QueuedSong): QueueTrack {
  return {
    ...toSong(q),
    durationS: q.audioDurationS ?? q.durationS ?? 0,
    audioUrl: signAudioUrl(env.PUBLIC_API_URL, q.id, env.AUDIO_URL_SIGNING_SECRET),
    ready: q.ready,
    bpm: q.bpm === null ? null : Math.round(q.bpm * 100) / 100,
    mixInS: q.mixInS,
    mixOutS: q.mixOutS,
    mixInBeatS: q.mixInBeatS,
    mixOutBeatS: q.mixOutBeatS,
    previewUrl: q.hasPreview
      ? signAudioUrl(env.PUBLIC_API_URL, q.id, env.AUDIO_URL_SIGNING_SECRET, 6 * 3600, "preview")
      : null,
    previewOffsetS: q.previewOffsetS,
    stems:
      q.stemsInS != null && q.stemsOutS != null
        ? { inS: q.stemsInS, outS: q.stemsOutS, ...stemUrls(q.id) }
        : null,
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
