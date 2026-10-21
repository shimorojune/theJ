import { playlistSongs, playlists, songs } from "@thej/db";
import { eq, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { labelsFrom, type RawSong, songId } from "./normalize";

/** A JS string[] as a Postgres text[] literal (drizzle would expand it into a row constructor). */
const textArray = (xs: string[]) =>
  sql`array[${sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  )}]::text[]`;

/** Upserts one playlist and its songs; labels accumulate on songs across every playlist they're in. */
export async function storePlaylist(
  source: string,
  externalId: string,
  name: string,
  categoryLabels: string[],
  items: RawSong[],
): Promise<{ songs: number; added: number }> {
  const labels = [...new Set([...categoryLabels, ...labelsFrom(name)])];
  const playlistId = `${source}:${externalId}`;
  await db
    .insert(playlists)
    .values({
      id: playlistId,
      source,
      externalId,
      name,
      labels,
      trackCount: items.length,
      crawledAt: new Date(),
    })
    .onConflictDoUpdate({
      target: playlists.id,
      set: { name, labels, trackCount: items.length, crawledAt: new Date() },
    });

  let added = 0;
  const seen = new Set<string>();
  for (const [position, raw] of items.entries()) {
    const id = songId(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    const row = {
      id,
      isrc: raw.isrc?.toUpperCase(),
      title: raw.title,
      artist: raw.artist,
      album: raw.album,
      year: raw.year,
      durationS: raw.durationS,
      deezerId: raw.deezerId,
      spotifyId: raw.spotifyId,
      youtubeId: raw.youtubeId,
      previewUrl: raw.previewUrl,
      thumbUrl: raw.thumbUrl,
      tempo: raw.tempo,
      labels,
    };
    const res = await db
      .insert(songs)
      .values(row)
      .onConflictDoUpdate({
        target: songs.id,
        set: {
          // Fill blanks from this source; never overwrite a value we already have.
          isrc: sql`coalesce(${songs.isrc}, ${row.isrc ?? null})`,
          album: sql`coalesce(${songs.album}, ${row.album ?? null})`,
          year: sql`coalesce(${songs.year}, ${row.year ?? null})`,
          durationS: sql`coalesce(${songs.durationS}, ${row.durationS ?? null})`,
          deezerId: sql`coalesce(${songs.deezerId}, ${row.deezerId ?? null})`,
          spotifyId: sql`coalesce(${songs.spotifyId}, ${row.spotifyId ?? null})`,
          youtubeId: sql`coalesce(${songs.youtubeId}, ${row.youtubeId ?? null})`,
          previewUrl: sql`coalesce(${songs.previewUrl}, ${row.previewUrl ?? null})`,
          thumbUrl: sql`coalesce(${songs.thumbUrl}, ${row.thumbUrl ?? null})`,
          tempo: sql`coalesce(${songs.tempo}, ${row.tempo ?? null})`,
          labels: sql`(select array_agg(distinct l) from unnest(${songs.labels} || ${textArray(labels)}) as l)`,
          sourceCount: sql`${songs.sourceCount} + 1`,
        },
      })
      .returning({ sourceCount: songs.sourceCount });
    if (res[0]?.sourceCount === 1) added++;
    await db
      .insert(playlistSongs)
      .values({ playlistId, songId: id, position })
      .onConflictDoNothing();
  }
  return { songs: seen.size, added };
}

export async function playlistCrawledRecently(source: string, externalId: string, days = 7) {
  const [p] = await db
    .select({ at: playlists.crawledAt })
    .from(playlists)
    .where(eq(playlists.id, `${source}:${externalId}`));
  return Boolean(p?.at && Date.now() - p.at.getTime() < days * 86_400_000);
}
