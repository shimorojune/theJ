import { songs } from "@thej/db";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { resolveSong } from "../lib/resolve";

/** YouTube video id for a catalog song: stored from the crawl, or found by a YouTube Music search. */
export async function youtubeIdFor(songId: string): Promise<string | null> {
  const [s] = await db
    .select({
      youtubeId: songs.youtubeId,
      title: songs.title,
      artist: songs.artist,
      durationS: songs.durationS,
      unavailableAt: songs.unavailableAt,
    })
    .from(songs)
    .where(eq(songs.id, songId));
  if (!s) throw new Error(`unknown song ${songId}`);
  if (s.youtubeId) return s.youtubeId;
  if (s.unavailableAt) return null;

  const hit = await resolveSong(`${s.title} ${s.artist.split(",")[0]}`);
  const lengthOk = !s.durationS || !hit || Math.abs(hit.durationS - s.durationS) <= 15;
  if (!hit || !lengthOk) {
    await db.update(songs).set({ unavailableAt: new Date() }).where(eq(songs.id, songId));
    return null;
  }
  await db.update(songs).set({ youtubeId: hit.videoId }).where(eq(songs.id, songId));
  return hit.videoId;
}
