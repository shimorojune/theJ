import type { Vibe } from "@thej/shared";

export type Song = {
  songId: string;
  title: string;
  artist: string;
  durationS: number;
  thumbUrl: string;
  audioUrl: string;
  /** Audio is pulled and playable. Until then the song is listed but not loaded. */
  ready?: boolean;
  bpm?: number | null;
  mixInS?: number | null;
  mixOutS?: number | null;
  /** Beat length (s) at each mix point, fitted to the audio; absent on older analyses. */
  mixInBeatS?: number | null;
  mixOutBeatS?: number | null;
  /** Analysed key and scale ("Eb", "minor"), for key-matching the hand-over. */
  key?: string | null;
  scale?: string | null;
  /** 30-second store preview to start on while the full audio is pulled. */
  previewUrl?: string | null;
  /** Where that preview sits inside the full audio, once the full song is pulled. */
  previewOffsetS?: number | null;
  /** Stems of the two mix windows for the DJ hand-over, once the server has split them. */
  stems?: {
    inS: number;
    outS: number;
    in: { drums: string; other: string; rest: string };
    out: { vocals: string; bass: string; rest: string };
  } | null;
  energy: number | null;
  valence: number | null;
  tempo: number | null;
};

/** What the api returns after every change, and what the SSE stream pushes. */
export type Queue = {
  sessionId: string;
  committed: Song[];
  liked: string[];
  moodText?: string;
  goal: Vibe;
  target: Vibe;
  skipTo?: string;
  upcoming?: Song[];
};

export const songsLeft = (q: Queue) => {
  const gap = Math.max(
    Math.abs(q.goal.energy - q.target.energy),
    Math.abs(q.goal.valence - q.target.valence),
  );
  return Math.ceil(gap / 0.08 - 1e-9);
};

/** One line describing where the DJ is heading, for the queue header. */
export function heading(q: Queue): string {
  const de = q.goal.energy - q.target.energy;
  const dv = q.goal.valence - q.target.valence;
  if (Math.abs(de) < 0.01 && Math.abs(dv) < 0.01) return "Holding the vibe";
  if (Math.abs(de) >= Math.abs(dv)) return de > 0 ? "Building up the energy" : "Bringing it down";
  return dv > 0 ? "Getting brighter" : "Getting moodier";
}

export const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};
