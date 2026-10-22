import { type Db, songs } from "@thej/db";
import { eq } from "drizzle-orm";

/**
 * 30-second store previews, so a song can start the instant it is picked while the full audio
 * is pulled. Deezer serves no previews in India, so they come from the iTunes Search API
 * (stable URLs, about 20 lookups a minute per IP). `songs.previewUrl` caches the answer:
 * an iTunes URL, "" for none, or anything else (null, an old Deezer link) for not looked up yet.
 */
const ITUNES = "https://itunes.apple.com/search";

export const isItunesPreview = (url: string | null | undefined): url is string =>
  Boolean(url?.startsWith("https://audio-ssl.itunes.apple.com/"));

/** Worth offering a preview URL for: found, or not looked up yet. */
export const mayHavePreview = (url: string | null | undefined) => url !== "";

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\b(feat|ft)\b.*$/, " ")
    .replace(/[^a-z0-9ऀ-ॿ]+/g, " ")
    .trim();

type Hit = { trackName: string; artistName: string; previewUrl?: string; trackTimeMillis?: number };

/** The store preview for a title and artist, or null when nothing matches well enough. */
export async function findPreview(song: {
  title: string;
  artist: string;
  durationS: number | null;
}): Promise<string | null> {
  const artist = song.artist.split(/,|&| x | and /i)[0]?.trim() ?? song.artist;
  const q = new URLSearchParams({
    term: `${song.title} ${artist}`,
    entity: "song",
    limit: "8",
    country: "IN",
  });
  const res = await fetch(`${ITUNES}?${q}`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`itunes ${res.status}`);
  const { results } = (await res.json()) as { results: Hit[] };
  const title = norm(song.title);
  const hit = results.find((r) => {
    if (!r.previewUrl) return false;
    const t = norm(r.trackName);
    if (!(t === title || t.startsWith(title) || title.startsWith(t))) return false;
    if (!song.durationS || !r.trackTimeMillis) return true;
    return Math.abs(r.trackTimeMillis / 1000 - song.durationS) <= 8;
  });
  return hit?.previewUrl ?? null;
}

/** The cached or freshly found preview URL for a catalog song; null when it has none. */
export async function previewUrlFor(db: Db, songId: string): Promise<string | null> {
  const [s] = await db
    .select({
      title: songs.title,
      artist: songs.artist,
      durationS: songs.durationS,
      previewUrl: songs.previewUrl,
    })
    .from(songs)
    .where(eq(songs.id, songId));
  if (!s) return null;
  if (isItunesPreview(s.previewUrl)) return s.previewUrl;
  if (s.previewUrl === "") return null;
  // A failed lookup (rate limit, network) is not recorded, so it is tried again next time.
  const url = await findPreview(s);
  await db
    .update(songs)
    .set({ previewUrl: url ?? "" })
    .where(eq(songs.id, songId));
  return url;
}
