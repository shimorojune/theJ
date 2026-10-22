/**
 * Catalog crawl (architecture v3, build step 1). Metadata only, never audio.
 * Usage: pnpm crawl [deezer|ytmusic|tag|embed|all] [--max-playlists N]
 */
import { songs } from "@thej/db";
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { connection } from "../lib/redis";
import { playlistTracks, searchPlaylists } from "./deezer";
import { embedPending } from "./embed";
import { sleep } from "./normalize";
import { playlistCrawledRecently, storePlaylist } from "./store";
import { tagUntagged } from "./tag";
import { categoryPlaylists, moodCategories, playlistSongs } from "./ytmusic";

const MOODS = [
  "sad",
  "romantic",
  "party",
  "dance",
  "chill",
  "lofi",
  "workout",
  "road trip",
  "late night",
  "feel good",
  "nostalgic",
  "wedding",
  "breakup",
  "acoustic",
  "sufi",
  "retro",
  "monsoon",
  "sunday morning",
];
const SCENES = [
  { suffix: "bollywood", labels: ["bollywood", "hindi"] },
  { suffix: "hindi", labels: ["hindi"] },
  { suffix: "punjabi", labels: ["punjabi"] },
  { suffix: "indie india", labels: ["indie", "india"] },
  { suffix: "pop", labels: ["pop", "english"] },
  { suffix: "hip hop", labels: ["hip hop", "english"] },
  { suffix: "90s", labels: ["90s"] },
  { suffix: "2000s", labels: ["2000s"] },
  { suffix: "2010s", labels: ["2010s"] },
];

const args = process.argv.slice(2);
const what = args[0] ?? "all";
const maxPlaylists = Number(args[args.indexOf("--max-playlists") + 1] || 100000);
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

async function crawlDeezer() {
  let done = 0;
  for (const mood of MOODS) {
    for (const scene of SCENES) {
      if (done >= maxPlaylists) return;
      const q = `${mood} ${scene.suffix}`;
      const lists = await searchPlaylists(q).catch((e: Error) => {
        log(`deezer search "${q}": ${e.message}`);
        return [];
      });
      for (const p of lists) {
        if (done >= maxPlaylists) return;
        if (await playlistCrawledRecently("deezer", String(p.id))) continue;
        try {
          const tracks = await playlistTracks(p.id);
          const r = await storePlaylist(
            "deezer",
            String(p.id),
            p.title,
            [mood, ...scene.labels],
            tracks,
          );
          done++;
          log(`deezer ${done} "${p.title}" ${r.songs} songs, ${r.added} new`);
        } catch (e) {
          log(`deezer playlist ${p.id}: ${(e as Error).message}`);
        }
        await sleep(300);
      }
      await sleep(500);
    }
  }
}

async function crawlYtMusic() {
  const cats = await moodCategories();
  log(`ytmusic: ${cats.length} categories`);
  let done = 0;
  for (const cat of cats) {
    if (/gaming|sleep|focus|kids|devotional|classical|podcast/i.test(cat.name)) continue;
    const ids = await categoryPlaylists(cat).catch((e: Error) => {
      log(`ytmusic category ${cat.name}: ${e.message}`);
      return [] as string[];
    });
    log(`ytmusic ${cat.name}: ${ids.length} playlists`);
    for (const id of ids) {
      if (done >= maxPlaylists) return;
      if (await playlistCrawledRecently("ytmusic", id)) continue;
      try {
        const { name, songs: items } = await playlistSongs(id);
        if (items.length < 10) continue;
        const r = await storePlaylist("ytmusic", id, name, [cat.name.toLowerCase()], items);
        done++;
        log(`ytmusic ${done} [${cat.name}] "${name}" ${r.songs} songs, ${r.added} new`);
      } catch (e) {
        log(`ytmusic playlist ${id}: ${(e as Error).message}`);
      }
      await sleep(800);
    }
  }
}

async function report() {
  const [c] = await db
    .select({
      songs: sql<number>`count(*)::int`,
      withIsrc: sql<number>`count(isrc)::int`,
      withYt: sql<number>`count(youtube_id)::int`,
      tagged: sql<number>`count(tagged_at)::int`,
    })
    .from(songs);
  const langs = await db.execute(
    sql`select l, count(*)::int n from songs, unnest(languages) l group by l order by n desc limit 6`,
  );
  log(`catalog: ${JSON.stringify(c)} languages: ${JSON.stringify(langs)}`);
}

// Embedding is cheap and sessions need it, so it runs first (whatever earlier runs left behind),
// after each crawl, and again after tags land. A redeploy mid-crawl then never leaves the
// catalogue unusable.
const embed = async () => log(`embedded ${await embedPending(log)} songs`);
if (what === "all") await embed();
if (what === "deezer" || what === "all") await crawlDeezer();
if (what === "all") await embed();
if (what === "ytmusic" || what === "all") await crawlYtMusic();
if (what === "embed" || what === "all") await embed();
if (what === "tag" || what === "all") {
  if (process.env.OPENROUTER_API_KEY) {
    log(`tagged ${await tagUntagged(Infinity, log)} songs`);
    log(`re-embedded ${await embedPending(log)} tagged songs`);
  } else log("OPENROUTER_API_KEY not set: skipping the tag pass");
}
await report();
await connection.quit();
process.exit(0);
