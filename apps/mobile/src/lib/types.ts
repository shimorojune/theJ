import type { Vibe } from "@thej/shared";

export type Song = {
  videoId: string;
  title: string;
  artist: string;
  durationS: number;
  thumbUrl: string;
  audioUrl: string;
  energy: number | null;
  valence: number | null;
  tempo: number | null;
};

/** What the api returns after every change, and what the SSE stream pushes. */
export type Queue = {
  sessionId: string;
  committed: Song[];
  liked: string[];
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
