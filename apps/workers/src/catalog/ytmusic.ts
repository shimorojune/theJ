import { Innertube } from "youtubei.js";
import type { RawSong } from "./normalize";

/** YouTube Music's Moods & genres shelves: good Hindi coverage, and the category is the mood label. */
let client: Promise<Innertube> | undefined;
const yt = () => (client ??= Innertube.create({ retrieve_player: false, location: "IN" }));

export type Category = { name: string; browseId: string; params: string };

export async function moodCategories(): Promise<Category[]> {
  // biome-ignore lint/suspicious/noExplicitAny: youtubei.js explore nodes are loosely typed
  const ex: any = await (await yt()).music.getExplore();
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const shelf = (ex.sections ?? []).find((s: any) => s.header?.title?.text === "Moods & genres");
  // biome-ignore lint/suspicious/noExplicitAny: see above
  return ((shelf?.contents ?? []) as any[])
    .filter((b) => b.endpoint?.payload?.browseId && typeof b.button_text === "string")
    .map((b) => ({
      name: b.button_text as string,
      browseId: b.endpoint.payload.browseId as string,
      params: b.endpoint.payload.params as string,
    }));
}

/** Playlist ids (without the VL prefix) shown under a category. */
export async function categoryPlaylists(cat: Category): Promise<string[]> {
  // biome-ignore lint/suspicious/noExplicitAny: raw InnerTube response
  const raw: any = await (await yt()).actions.execute("/browse", {
    browseId: cat.browseId,
    params: cat.params,
    client: "YTMUSIC",
    parse: false,
  });
  const s = JSON.stringify(raw.data ?? raw);
  return [
    ...new Set([...s.matchAll(/"browseId":"VL([A-Za-z0-9_-]+)"/g)].map((m) => m[1] as string)),
  ];
}

export async function playlistSongs(
  id: string,
): Promise<{ name: string; songs: (RawSong & { youtubeId: string })[] }> {
  // biome-ignore lint/suspicious/noExplicitAny: youtubei.js playlist nodes are loosely typed
  const pl: any = await (await yt()).music.getPlaylist(id);
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const items: any[] = pl.items ?? pl.contents ?? [];
  const songs = items
    .filter((i) => typeof i.id === "string" && i.id.length === 11 && (i.title?.text ?? i.title))
    .map((i) => {
      // biome-ignore lint/suspicious/noExplicitAny: see above
      const artists: any[] = i.artists ?? i.authors ?? i.flex_columns?.[1]?.title?.runs ?? [];
      const artist = artists
        .map((a) => a.name ?? a.text)
        .filter((a) => typeof a === "string" && a.length > 0)
        .join(", ");
      return {
        title: String(i.title?.text ?? i.title),
        artist: artist || "Unknown",
        durationS: i.duration?.seconds,
        youtubeId: i.id as string,
        thumbUrl: i.thumbnail?.contents?.[0]?.url?.replace(/=w\d+-h\d+/, "=w544-h544"),
      };
    });
  return { name: String(pl.header?.title?.text ?? id), songs };
}
