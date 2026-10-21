/**
 * Build step 1 spike: resolve 50 Hindi + English songs, insert them as tracks, queue fetches.
 * Usage: pnpm --filter @thej/workers seed
 */
import { tracks } from "@thej/db";
import { db } from "../lib/db";
import { enqueueFetch, fetchQueue } from "../lib/queues";
import { connection } from "../lib/redis";
import { resolveSong } from "../lib/resolve";

const HINDI = [
  "Kesariya Arijit Singh",
  "Tum Hi Ho Arijit Singh",
  "Kal Ho Naa Ho Sonu Nigam",
  "Gallan Goodiyaan Dil Dhadakne Do",
  "Badtameez Dil Benny Dayal",
  "Apna Bana Le Arijit Singh",
  "Chaiyya Chaiyya Sukhwinder Singh",
  "London Thumakda Labh Janjua",
  "Kala Chashma Badshah",
  "Ghungroo Arijit Singh Shilpa Rao",
  "Channa Mereya Arijit Singh",
  "Raataan Lambiyan Jubin Nautiyal",
  "Malhari Vishal Dadlani",
  "Senorita Zindagi Na Milegi Dobara",
  "Jhoome Jo Pathaan Arijit Singh",
  "Tere Vaaste Varun Jain",
  "Pasoori Ali Sethi Shae Gill",
  "Kar Gayi Chull Badshah",
  "Dil Diyan Gallan Atif Aslam",
  "Ilahi Arijit Singh",
  "Desi Girl Shankar Mahadevan",
  "Nashe Si Chadh Gayi Arijit Singh",
  "Bole Chudiyan Kabhi Khushi Kabhie Gham",
  "Tum Se Hi Mohit Chauhan",
  "Zinda Siddharth Mahadevan",
];

const ENGLISH = [
  "Levitating Dua Lipa",
  "Blinding Lights The Weeknd",
  "Shape of You Ed Sheeran",
  "Peaches Justin Bieber",
  "Uptown Funk Bruno Mars",
  "Don't Start Now Dua Lipa",
  "As It Was Harry Styles",
  "Bad Guy Billie Eilish",
  "Get Lucky Daft Punk",
  "Happy Pharrell Williams",
  "Flowers Miley Cyrus",
  "Mr. Brightside The Killers",
  "Dance Monkey Tones and I",
  "Shut Up and Dance Walk the Moon",
  "Can't Stop the Feeling Justin Timberlake",
  "Watermelon Sugar Harry Styles",
  "Someone Like You Adele",
  "Stay The Kid Laroi Justin Bieber",
  "Counting Stars OneRepublic",
  "Sunflower Post Malone Swae Lee",
  "Espresso Sabrina Carpenter",
  "Viva La Vida Coldplay",
  "Perfect Ed Sheeran",
  "Starboy The Weeknd",
  "Titanium David Guetta Sia",
];

const songs = [
  ...HINDI.map((q) => ({ q, languages: ["hi"] })),
  ...ENGLISH.map((q) => ({ q, languages: ["en"] })),
];

let queued = 0;
for (const { q, languages } of songs) {
  const r = await resolveSong(q).catch((e: Error) => {
    console.warn(`resolve failed: ${q}: ${e.message}`);
    return null;
  });
  if (!r) {
    console.warn(`no match: ${q}`);
    continue;
  }
  await db
    .insert(tracks)
    .values({ ...r, languages })
    .onConflictDoNothing();
  await enqueueFetch(r.videoId);
  queued++;
  console.log(`${r.videoId}  ${r.artist} – ${r.title}`);
}

console.log(`queued ${queued}/${songs.length}`);
await fetchQueue.close();
await connection.quit();
process.exit(0);
