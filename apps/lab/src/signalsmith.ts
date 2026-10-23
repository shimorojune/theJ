/**
 * Signalsmith Stretch (vendor/signalsmith, built by tools/stretch) for the incoming deck: the
 * stretcher the app would ship to match tempo and key cleanly, where react-native-audio-api's
 * own WSOLA distorts a pitch shift. Offline: one call renders the deck's whole stretch.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = join(ROOT, "tools/stretch/stretch.cpp");
const BIN = join(ROOT, "tools/stretch/.bin/stretch");
const run = promisify(execFile);

/** Build the stretcher once (clang, a second or two). */
async function binary(): Promise<string> {
  if (!existsSync(BIN)) {
    await mkdir(dirname(BIN), { recursive: true });
    await run("clang++", [
      "-O2",
      "-std=c++17",
      `-I${join(ROOT, "vendor/signalsmith")}`,
      "-o",
      BIN,
      SRC,
    ]);
  }
  return BIN;
}

let seq = 0;

/**
 * `frames` of `src` from frame `start` at playback rate `rate` and `semis` pitch shift, both
 * moving linearly to 1 and 0 between output frames `rampFrom` and `rampTo`.
 */
export async function signalsmithDeck(
  src: Float32Array[],
  start: number,
  frames: number,
  sampleRate: number,
  rate: number,
  semis: number,
  rampFrom: number,
  rampTo: number,
): Promise<Float32Array[]> {
  const bin = await binary();
  const dir = join(tmpdir(), "thej-lab-stretch");
  await mkdir(dir, { recursive: true });
  const base = join(dir, `${process.pid}-${++seq}`);
  // Enough input for the whole output at the fastest rate, and no more than the song has.
  const len = Math.max(
    0,
    Math.min((src[0]?.length ?? 0) - start, Math.ceil(frames * Math.max(rate, 1)) + 48000),
  );
  const planar = new Float32Array(len * 2);
  planar.set((src[0] as Float32Array).subarray(start, start + len), 0);
  planar.set((src[1] ?? (src[0] as Float32Array)).subarray(start, start + len), len);
  await writeFile(`${base}.in.f32`, Buffer.from(planar.buffer));
  await run(bin, [
    `${base}.in.f32`,
    `${base}.out.f32`,
    String(sampleRate),
    String(frames),
    String(rate),
    String(semis),
    String(Math.round(rampFrom)),
    String(Math.round(rampTo)),
  ]);
  const bytes = await readFile(`${base}.out.f32`);
  const out = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  await Promise.all([
    rm(`${base}.in.f32`, { force: true }),
    rm(`${base}.out.f32`, { force: true }),
  ]);
  return [out.slice(0, frames), out.slice(frames, frames * 2)];
}
