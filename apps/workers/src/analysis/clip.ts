import { join } from "node:path";
import { run } from "../lib/run";

/** Song length in seconds, from the file itself. */
export async function probeDuration(path: string): Promise<number> {
  const out = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    path,
  ]);
  return Number(out.trim());
}

/**
 * ReccoBeats only analyses the first 30 s of an upload, and intros skew everything. So cut a 30 s
 * stereo MP3 starting at the 35% mark (~0.7 MB), well under its 5 MB limit.
 */
export async function cutClip(input: string, dir: string, durationS: number): Promise<string> {
  const out = join(dir, "clip.mp3");
  const start = Math.max(0, Math.min(durationS * 0.35, durationS - 30));
  await run("ffmpeg", [
    "-loglevel",
    "error",
    "-ss",
    start.toFixed(1),
    "-t",
    "30",
    "-i",
    input,
    // Must be stereo: ReccoBeats answers 400 "Get audio features fail" for mono (tested 2026-10-21).
    "-ac",
    "2",
    "-ar",
    "44100",
    "-b:a",
    "192k",
    out,
  ]);
  return out;
}
