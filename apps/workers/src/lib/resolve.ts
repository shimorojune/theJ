import { Innertube } from "youtubei.js";

export type Resolved = {
  videoId: string;
  title: string;
  artist: string;
  durationS: number;
  thumbUrl: string | undefined;
};

let client: Promise<Innertube> | undefined;
const yt = () => (client ??= Innertube.create({ retrieve_player: false }));

/**
 * "artist – title" to a YouTube video id via YouTube Music song search. Song results are the
 * official Topic / Art Track uploads, which are the clean audio we want.
 */
export async function resolveSong(query: string): Promise<Resolved | null> {
  const res = await (await yt()).music.search(query, { type: "song" });
  // biome-ignore lint/suspicious/noExplicitAny: youtubei.js shelf items are loosely typed
  const items: any[] = (res.contents?.[0] as any)?.contents ?? [];
  const q = query.toLowerCase();
  // The top result is sometimes a different song by the same artist: require a title word to match.
  const titleMatches = (title: string) =>
    title
      .toLowerCase()
      .replace(/[([].*?[)\]]/g, "")
      .split(/[^\p{L}\p{N}]+/u)
      .some((w) => w.length >= 3 && q.includes(w));
  const artistMatches = (i: { artists?: { name: string }[] }) =>
    (i.artists ?? []).some((a) => q.includes(a.name.toLowerCase()));
  const candidates = items.filter(
    (i) =>
      i.id && i.duration?.seconds > 60 && i.duration.seconds < 600 && titleMatches(i.title ?? ""),
  );
  // Prefer a result by an artist named in the query (skips covers and emulations).
  const hit = candidates.find(artistMatches) ?? candidates[0];
  if (!hit) return null;
  return {
    videoId: hit.id,
    title: hit.title,
    artist: (hit.artists ?? []).map((a: { name: string }) => a.name).join(", "),
    durationS: hit.duration.seconds,
    // Ask for a bigger square than the 120px search thumbnail.
    thumbUrl: hit.thumbnail?.contents?.[0]?.url?.replace(/=w\d+-h\d+/, "=w544-h544"),
  };
}
