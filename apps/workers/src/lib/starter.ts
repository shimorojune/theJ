/** Starter shelf: popular Hindi and English songs, so a fresh install has something to play. */
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

export const STARTER = [
  ...HINDI.map((q) => ({ q, languages: ["hi"] })),
  ...ENGLISH.map((q) => ({ q, languages: ["en"] })),
];

/** Resolves the starter list on YouTube Music, stores the tracks and queues their downloads. */
export async function seedStarter(deps: {
  resolve: (q: string) => Promise<{
    videoId: string;
    title: string;
    artist: string;
    durationS: number;
    thumbUrl: string | undefined;
  } | null>;
  insert: (t: {
    videoId: string;
    title: string;
    artist: string;
    durationS: number;
    thumbUrl: string | undefined;
    languages: string[];
  }) => Promise<void>;
  enqueue: (videoId: string) => Promise<unknown>;
  log?: (line: string) => void;
}): Promise<number> {
  let queued = 0;
  for (const { q, languages } of STARTER) {
    const r = await deps.resolve(q).catch((e: Error) => {
      deps.log?.(`resolve failed: ${q}: ${e.message}`);
      return null;
    });
    if (!r) {
      deps.log?.(`no match: ${q}`);
      continue;
    }
    await deps.insert({ ...r, languages });
    await deps.enqueue(r.videoId);
    queued++;
    deps.log?.(`${r.videoId}  ${r.artist} – ${r.title}`);
  }
  return queued;
}
