/**
 * Stems for the lab's hand-overs: htdemucs through tools/mixlab/stems.py (the repo's
 * .venv-mixlab), one worker kept running so the model loads once. Whole-song stem envelopes
 * (where the vocals are) come from `stems.py envelopes`, cached next to the audio.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { audioPath, type LabSong } from "./data";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PYTHON = join(ROOT, ".venv-mixlab/bin/python");
const SCRIPT = join(ROOT, "tools/mixlab/stems.py");
const TMP = join(tmpdir(), "thej-lab-stems");

export const STEM_NAMES = ["drums", "bass", "other", "vocals"] as const;
export type Stems = Record<(typeof STEM_NAMES)[number], Float32Array[]>;

/** Whether stems can be made here at all (the mix lab's Python environment is present). */
export const stemsAvailable = () => existsSync(PYTHON);

/** A song's stem envelopes (dB every 1/hz s), if `stems.py envelopes` has been run for it. */
export async function stemEnvelopes(
  song: LabSong,
): Promise<{ hz: number; vocals: number[]; music: number[] } | null> {
  const path = audioPath(song).replace(/\.m4a$/, ".stems.json");
  const env = await readFile(path, "utf8")
    .then(
      (t) =>
        JSON.parse(t) as Record<"drums" | "bass" | "other" | "vocals", number[]> & { hz: number },
    )
    .catch(() => null);
  if (!env) return null;
  // Everything but the vocals, power-summed: what the singing has to stand out from.
  const music = env.vocals.map(
    (_, k) =>
      10 *
      Math.log10(
        10 ** ((env.drums[k] ?? -120) / 10) +
          10 ** ((env.bass[k] ?? -120) / 10) +
          10 ** ((env.other[k] ?? -120) / 10) +
          1e-12,
      ),
  );
  return { hz: env.hz, vocals: env.vocals, music };
}

let worker: ChildProcessWithoutNullStreams | null = null;
let queue: Promise<unknown> = Promise.resolve();
const waiting: ((ok: boolean) => void)[] = [];

function start() {
  if (worker) return worker;
  const w = spawn(PYTHON, [SCRIPT, "serve"], { stdio: ["pipe", "pipe", "pipe"] });
  createInterface({ input: w.stdout }).on("line", () => waiting.shift()?.(true));
  w.stderr.on("data", () => {});
  w.on("exit", () => {
    worker = null;
    for (const done of waiting.splice(0)) done(false);
  });
  worker = w;
  return w;
}

const cache = new Map<string, Promise<Stems>>();

/**
 * Stems of `x` (stereo, at `sampleRate`) from `startS` for `lenS` seconds, cached per song and
 * window. Jobs run one at a time on the worker.
 */
export function separate(
  key: string,
  x: Float32Array[],
  sampleRate: number,
  startS: number,
  lenS: number,
): Promise<Stems> {
  const id = `${key}:${startS.toFixed(3)}:${lenS.toFixed(3)}`;
  let p = cache.get(id);
  if (!p) {
    const job = queue.then(async () => {
      await mkdir(TMP, { recursive: true });
      const a = Math.max(0, Math.round(startS * sampleRate));
      const n = Math.round(lenS * sampleRate);
      const inter = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        inter[i * 2] = (x[0] as Float32Array)[a + i] ?? 0;
        inter[i * 2 + 1] = (x[1] ?? (x[0] as Float32Array))[a + i] ?? 0;
      }
      const base = join(TMP, `${process.pid}-${cache.size}`);
      await writeFile(`${base}.in.f32`, Buffer.from(inter.buffer));
      const w = start();
      const ok = await new Promise<boolean>((resolve) => {
        waiting.push(resolve);
        w.stdin.write(`${JSON.stringify({ in: `${base}.in.f32`, out: base, sr: sampleRate })}\n`);
      });
      if (!ok) throw new Error("stem separation failed");
      const out = {} as Stems;
      for (const name of STEM_NAMES) {
        const bytes = await readFile(`${base}.${name}.f32`);
        const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        const l = new Float32Array(n);
        const r = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          l[i] = f[i * 2] as number;
          r[i] = f[i * 2 + 1] as number;
        }
        out[name] = [l, r];
        await rm(`${base}.${name}.f32`, { force: true });
      }
      await rm(`${base}.in.f32`, { force: true });
      return out;
    });
    queue = job.catch(() => {});
    p = job;
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

/** Let the worker go (the CLI calls this when it is done, or Node would wait on it). */
export function stopStems() {
  worker?.kill();
  worker = null;
}
