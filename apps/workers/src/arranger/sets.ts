/**
 * Validation for the arranger: print a 12-song set for a few moods from the real catalog.
 * Usage: pnpm sets [languages=hi,en]
 */
import { type Candidate, choose, embedText, pickCandidates } from "@thej/core";
import { stepToward } from "@thej/shared";
import { embedPending } from "../catalog/embed";
import { db } from "../lib/db";
import { connection } from "../lib/redis";

const languages = (process.argv[2] ?? "hi,en").split(",");

const MOODS = [
  { description: "sad heartbreak slow emotional bollywood", energy: 0.3, valence: 0.25 },
  { description: "dinner soft acoustic romantic warm", energy: 0.35, valence: 0.6 },
  { description: "warm feel good singalong nostalgic bollywood pop", energy: 0.55, valence: 0.7 },
  { description: "dance floor party hype bollywood hits", energy: 0.85, valence: 0.8 },
  { description: "late night moody deep chill hip hop", energy: 0.55, valence: 0.3 },
];

console.log("embedding pending songs…");
await embedPending(() => {});

const f = (n: number | null) => (n == null ? "  - " : n.toFixed(2));
for (const mood of MOODS) {
  console.log(`\n== ${mood.description}  (e ${mood.energy}, v ${mood.valence})`);
  const moodEmbedding = await embedText(mood.description);
  const exclude: string[] = [];
  let target = { energy: mood.energy * 0.6 + 0.2, valence: 0.5 }; // start mid, ramp in
  let current: Candidate | undefined;
  for (let i = 0; i < 12; i++) {
    target = stepToward(target, { energy: mood.energy, valence: mood.valence });
    const cands = await pickCandidates(db, {
      moodEmbedding,
      energy: target.energy,
      valence: target.valence,
      languages,
      exclude,
      liked: [],
      currentTempo: current?.tempo ?? null,
      limit: 20,
    });
    current = choose(cands);
    if (!current) break;
    exclude.push(current.id);
    console.log(
      `${String(i + 1).padStart(2)}  e ${f(current.energy)} v ${f(current.valence)} ${String(current.tempo ? Math.round(current.tempo) : "-").padStart(3)}bpm  ${current.era ?? "    "}  ${current.artist.split(",")[0]} – ${current.title}`,
    );
  }
}
await connection.quit();
process.exit(0);
