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
};

const SCRIPT = fileURLToPath(new URL("./beats.py", import.meta.url));

/**
 * Beat grid, tempo and key via Essentia (python3 in the streamer image), plus mix points:
 * the next song comes in on the first downbeat after a short intro, and this one hands over
 * 8 bars before its end, on a beat. The phone lines the two up.
 */
export async function analyse(path: string): Promise<Analysis> {
  const out = await run("python3", [SCRIPT, path]);
  const a = JSON.parse(out.slice(out.indexOf("{"))) as Omit<Analysis, "mixInS" | "mixOutS">;
  const beatLen = a.bpm > 0 ? 60 / a.bpm : 0.6;
  const eightBars = 32 * beatLen;

  const mixInS = a.beats.find((b) => b >= 1.5) ?? Math.min(2, a.durationS);
  const outTarget = a.durationS - eightBars;
  const mixOutS =
    [...a.beats].reverse().find((b) => b <= outTarget) ?? Math.max(mixInS + 10, a.durationS - 10);
  return { ...a, mixInS, mixOutS };
}
