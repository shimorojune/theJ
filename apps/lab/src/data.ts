import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MixSong } from "@thej/mix";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
export const CACHE = process.env.THEJ_LAB_CACHE ?? join(HERE, "../.cache");
export const OUT = join(HERE, "../out");

/** A pulled song with its analysis, as /lab/songs returns it. */
export type LabSong = MixSong & {
  songId: string;
  title: string;
  artist: string;
  durationS: number;
  key?: string | null;
  scale?: string | null;
  beatConfidence?: number | null;
  /** Beat times (s), as analysed. */
  beats?: number[] | null;
  stemsInS?: number | null;
  stemsOutS?: number | null;
  audioUrl: string;
};

const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
export const audioPath = (s: LabSong) => join(CACHE, `${safe(s.songId)}.m4a`);

/** The VPS api and the dev token the phone build uses (apps/mobile/.env), unless set in env. */
async function apiAuth() {
  const base = process.env.THEJ_API ?? "https://thej.rraj.dev";
  let token = process.env.THEJ_DEV_TOKEN;
  if (!token) {
    const env = await readFile(join(ROOT, "apps/mobile/.env"), "utf8").catch(() => "");
    token = /^EXPO_PUBLIC_DEV_TOKEN=(.*)$/m.exec(env)?.[1]?.trim();
  }
  if (!token) throw new Error("set THEJ_DEV_TOKEN (the api's DEV_AUTH_TOKEN)");
  return {
    base,
    headers: { "x-dev-user": process.env.THEJ_DEV_USER ?? "lab", "x-dev-token": token },
  };
}

export async function apiGet<T>(path: string): Promise<T> {
  const { base, headers } = await apiAuth();
  const res = await fetch(base + path, { headers });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Refresh the song list and download any audio not cached yet. The audio comes from the api's
 * own store of pulled songs, never from YouTube, so this costs the home proxy nothing.
 */
export async function fetchSongs(limit: number, log = console.log) {
  await mkdir(CACHE, { recursive: true });
  const songs = await apiGet<LabSong[]>(`/lab/songs?limit=${limit}`);
  let fresh = 0;
  for (const s of songs) {
    const dest = audioPath(s);
    if (existsSync(dest)) continue;
    const res = await fetch(s.audioUrl);
    if (!res.ok) {
      log(`skip ${s.title}: ${res.status}`);
      continue;
    }
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    fresh++;
  }
  // Merged into what is cached already: a small fetch only adds the newest songs.
  const known = await readFile(join(CACHE, "songs.json"), "utf8")
    .then((t) => JSON.parse(t) as LabSong[])
    .catch(() => []);
  const all = new Map([...known, ...songs].map((s) => [s.songId, s]));
  await writeFile(join(CACHE, "songs.json"), JSON.stringify([...all.values()], null, 1));
  log(`${songs.length} songs listed, ${fresh} downloaded, ${all.size} known, cache ${CACHE}`);
}

/** Cached songs that can be mixed: audio on disk and a beat analysis. */
export async function library(): Promise<LabSong[]> {
  const raw = await readFile(join(CACHE, "songs.json"), "utf8").catch(() => {
    throw new Error("no songs cached yet: run `pnpm mix fetch` first");
  });
  return (JSON.parse(raw) as LabSong[]).filter(
    (s) => s.bpm && s.mixInS != null && s.mixOutS != null && existsSync(audioPath(s)),
  );
}

/** A song by id, or by words from its title or artist. */
export function find(songs: LabSong[], q: string): LabSong {
  const exact = songs.find((s) => s.songId === q);
  if (exact) return exact;
  const words = q.toLowerCase().split(/\s+/);
  const hits = songs.filter((s) => {
    const hay = `${s.title} ${s.artist}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  if (hits.length === 1) return hits[0] as LabSong;
  if (!hits.length) throw new Error(`no cached song matches "${q}" (pnpm mix list)`);
  throw new Error(
    `"${q}" matches ${hits.length} songs: ${hits
      .slice(0, 5)
      .map((s) => s.title)
      .join(" | ")}`,
  );
}
