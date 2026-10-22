import type { Song } from "../lib/types";

export type EngineStatus = {
  /** Song id the engine is playing, or null. */
  current: string | null;
  playing: boolean;
  buffering: boolean;
  currentTime: number;
  duration: number;
};

export type TrackChange = {
  from: string | null;
  to: string | null;
  /** Why `from` ended: it played out (or was mixed out), or the user skipped it. */
  reason: "complete" | "skip";
};

/**
 * A playback engine the party talks to. It receives the server's committed queue (only songs
 * whose audio is ready) and reports what it is doing; the server decides what plays.
 */
export interface Engine {
  /** Replace the queue. The current song stays if it is still in the list; the rest are re-lined. */
  setQueue(songs: Song[]): void;
  /** Jump to the song after the current one. `reason` is what the server is told about the current one. */
  next(reason: "skip" | "complete"): void;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  restart(): void;
  setRepeat(on: boolean): void;
  /** Stop everything and forget the queue. */
  clear(): void;
  onStatus(cb: (s: EngineStatus) => void): () => void;
  onTrackChange(cb: (c: TrackChange) => void): () => void;
  destroy(): void;
}
