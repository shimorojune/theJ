import { fileURLToPath } from "node:url";
import { run } from "../lib/run";

export type Analysis = {
  bpm: number;
  beats: number[];
  confidence: number;
  key: string;
  scale: string;
  durationS: number;
  mixInS: number;
  mixOutS: number;
  /** Beat length (s) of the grid fitted at each mix point; null without a beat grid. */
  mixInBeatS: number | null;
  mixOutBeatS: number | null;
};

const SCRIPT = fileURLToPath(new URL("./beats.py", import.meta.url));
const PREVIEW_SCRIPT = fileURLToPath(new URL("./preview_offset.py", import.meta.url));
const STEMS_SCRIPT = fileURLToPath(new URL("./stems.py", import.meta.url));

/** Below this the preview may be a different recording or edit; the phone then mixes instead. */
const MIN_PREVIEW_MATCH = 0.6;

/**
 * Beat grid, tempo and key via Essentia (python3 in the streamer image), plus mix points with a
 * beat grid fitted to the song's onsets at each (see beats.py). The phone lines the two up.
 */
export async function analyse(path: string): Promise<Analysis> {
  const out = await run("python3", [SCRIPT, path]);
  return JSON.parse(out.slice(out.indexOf("{"))) as Analysis;
}

/** Where the store preview starts inside the full audio, when the two clearly match. */
export async function previewOffset(
  full: string,
  preview: string,
): Promise<{ offsetS: number | null; match: number }> {
  const out = await run("python3", [PREVIEW_SCRIPT, full, preview]);
  const r = JSON.parse(out.slice(out.indexOf("{"))) as { offsetS: number | null; match: number };
  return { offsetS: r.match >= MIN_PREVIEW_MATCH ? r.offsetS : null, match: r.match };
}

/** The stem parts the phone's hand-over uses, per window (see stems.py). */
export const STEM_PARTS = [
  "in-drums",
  "in-other",
  "in-rest",
  "out-vocals",
  "out-bass",
  "out-rest",
] as const;
export type StemPart = (typeof STEM_PARTS)[number];

/**
 * Split the song's two mix windows into stems, written as `<prefix>.<part>.m4a`. The mix-in
 * window runs from the mix-in beat for 28 beats (room for an 8% stretch); the mix-out window
 * from 2 beats before the mix-out beat for 32 (room for a mix that starts a bar late).
 */
export async function splitStems(
  path: string,
  prefix: string,
  a: Pick<Analysis, "bpm" | "mixInS" | "mixOutS" | "mixInBeatS" | "mixOutBeatS">,
): Promise<{ inS: number; outS: number }> {
  const beatIn = a.mixInBeatS || (a.bpm > 0 ? 60 / a.bpm : 0.5);
  const beatOut = a.mixOutBeatS || (a.bpm > 0 ? 60 / a.bpm : 0.5);
  const out = await run("python3", [
    STEMS_SCRIPT,
    path,
    prefix,
    String(a.mixInS),
    String(28 * beatIn * 1.1),
    String(a.mixOutS - 2 * beatOut),
    String(32 * beatOut),
  ]);
  return JSON.parse(out.slice(out.lastIndexOf("{"))) as { inS: number; outS: number };
}
