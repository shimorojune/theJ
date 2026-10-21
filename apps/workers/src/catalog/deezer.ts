import type { RawSong } from "./normalize";
import { sleep } from "./normalize";

/** Deezer's public API: no key, ~50 requests per 5 s. Playlists carry ISRCs, which drive dedupe. */
const BASE = "https://api.deezer.com";

type DzPlaylist = { id: number; title: string; nb_tracks: number; public: boolean };
type DzTrack = {
  id: number;
  title: string;
  isrc?: string;
  duration: number;
  preview?: string;
  artist: { name: string };
  album?: { title: string; cover_medium?: string; release_date?: string };
};

async function get<T>(path: string, attempt = 0): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(20_000) });
  const body = (await res.json()) as T & { error?: { code: number; message: string } };
  if (body.error) {
    // 4 = quota exceeded: back off and retry a few times.
    if (body.error.code === 4 && attempt < 5) {
      await sleep(2000 * (attempt + 1));
      return get<T>(path, attempt + 1);
    }
    throw new Error(`deezer ${path}: ${body.error.message}`);
  }
  return body;
}

export async function searchPlaylists(q: string, limit = 25): Promise<DzPlaylist[]> {
  const r = await get<{ data: DzPlaylist[] }>(
    `/search/playlist?q=${encodeURIComponent(q)}&limit=${limit}`,
  );
  return r.data.filter((p) => p.nb_tracks >= 15 && p.nb_tracks <= 500);
}

/** All tracks of a playlist, 100 per page. */
export async function playlistTracks(id: number): Promise<RawSong[]> {
  const out: RawSong[] = [];
  for (let index = 0; index < 1000; index += 100) {
    const r = await get<{ data: DzTrack[]; next?: string }>(
      `/playlist/${id}/tracks?limit=100&index=${index}`,
    );
    for (const t of r.data) {
      if (!t.title || !t.artist?.name) continue;
      out.push({
        title: t.title,
        artist: t.artist.name,
        album: t.album?.title,
        year: t.album?.release_date ? Number(t.album.release_date.slice(0, 4)) : undefined,
        durationS: t.duration,
        isrc: t.isrc,
        deezerId: String(t.id),
        previewUrl: t.preview,
        thumbUrl: t.album?.cover_medium,
      });
    }
    if (!r.next) break;
    await sleep(150);
  }
  return out;
}
