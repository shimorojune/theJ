import { createHash } from "node:crypto";

/** A song as any source reports it, before dedupe. */
export type RawSong = {
  title: string;
  artist: string;
  album?: string;
  year?: number;
  durationS?: number;
  isrc?: string;
  deezerId?: string;
  spotifyId?: string;
  youtubeId?: string;
  previewUrl?: string;
  thumbUrl?: string;
  tempo?: number;
};

const NOISE =
  /\s*[([](?:from|feat\.?|ft\.?|official|remaster|version|edit|mix|live|lyric|video|audio|soundtrack|original)[^)\]]*[)\]]/gi;

/** "Kesariya (From "Brahmastra") [Official Audio]" → "kesariya"; strips accents, punctuation and noise. */
export function normaliseTitle(title: string): string {
  return title
    .replace(NOISE, "")
    .replace(/\s+-\s+.*$/, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** First credited artist only, so "Pritam, Arijit Singh" and "Arijit Singh" can still match by title. */
export function primaryArtist(artist: string): string {
  return (
    artist
      .split(/,|&|\bfeat\.?\b|\bft\.?\b|\bx\b|\|/i)[0]
      ?.normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim() ?? ""
  );
}

/** Stable id: the ISRC when a source gives one, else a hash of primary artist + normalised title. */
export function songId(s: RawSong): string {
  if (s.isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(s.isrc)) return `isrc:${s.isrc.toUpperCase()}`;
  const key = `${primaryArtist(s.artist)}|${normaliseTitle(s.title)}`;
  return `key:${createHash("sha1").update(key).digest("hex").slice(0, 16)}`;
}

/** Playlist names and category names → lowercase labels ("Sad Bollywood Songs 2024" → ["sad", "bollywood"]). */
const STOP = new Set([
  "songs",
  "song",
  "music",
  "playlist",
  "best",
  "top",
  "hits",
  "hit",
  "the",
  "of",
  "and",
  "for",
  "a",
  "an",
  "in",
  "to",
  "new",
  "latest",
  "mix",
  "collection",
  "all",
  "time",
  "ever",
  "official",
  "full",
  "nonstop",
  "jukebox",
  "vol",
  "part",
  "2020",
  "2021",
  "2022",
  "2023",
  "2024",
  "2025",
  "2026",
]);
export function labelsFrom(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)),
    ),
  ].slice(0, 8);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
