const BASE = "https://lrclib.net/api";
const HEADERS = { "User-Agent": "theJ/0.1 (party DJ app)" };

type LrcRecord = {
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
};

/** Drops "(From "Brahmastra")", "[Official Audio]", "- Remastered" etc. for a better lyrics match. */
export function cleanTitle(title: string): string {
  return title
    .replace(/\s*[([].*?[)\]]/g, "")
    .replace(/\s+-\s+.*$/, "")
    .trim();
}

/**
 * Words per minute of sung lyrics, for the "fewer lyrics" ramp. null when LRCLIB has no lyrics
 * for it. LRCLIB's `instrumental` flag is unreliable (empty uploads of vocal songs carry it), so
 * instrumentals are decided from ReccoBeats' instrumentalness by the caller instead.
 */
export async function wordsPerMinute(
  title: string,
  artist: string,
  durationS: number,
): Promise<number | null> {
  const rec = await findLyrics(
    cleanTitle(title),
    artist.split(",")[0]?.trim() ?? artist,
    durationS,
  );
  const text = rec?.plainLyrics ?? rec?.syncedLyrics?.replace(/\[[\d:.]+\]/g, "");
  if (!text?.trim()) return null;
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.round((words / (durationS / 60)) * 10) / 10;
}

async function findLyrics(
  track: string,
  artist: string,
  durationS: number,
): Promise<LrcRecord | null> {
  const q = new URLSearchParams({ track_name: track, artist_name: artist });
  const res = await fetch(`${BASE}/search?${q}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const hits = (await res.json()) as LrcRecord[];
  // Same song if the lengths agree within 10 s; prefer the closest.
  return (
    hits
      .filter((h) => Math.abs(h.duration - durationS) <= 10 && (h.plainLyrics || h.syncedLyrics))
      .sort((a, b) => Math.abs(a.duration - durationS) - Math.abs(b.duration - durationS))[0] ??
    null
  );
}
