/**
 * Validation for the arranger: print a 12-song set for a few moods from the real catalog.
 * Usage: pnpm sets [languages=hi,en]
 */
import { stepToward } from "@thej/shared";
import { embedPending } from "../catalog/embed";
import { connection } from "../lib/redis";
import { type Candidate, choose, pickCandidates, type Target } from "./pick";

const languages = (process.argv[2] ?? "hi,en").split(",");

const MOODS: Target[] = [
  { description: "sad heartbreak slow emotional bollywood", energy: 0.3, valence: 0.25, languages },
  { description: "dinner soft acoustic romantic warm", energy: 0.35, valence: 0.6, languages },
  { description: "warm feel good singalong nostalgic", energy: 0.55, valence: 0.7, languages },
  { description: "dance floor party hype bollywood hits", energy: 0.85, valence: 0.8, languages },
  { description: "late night moody deep chill hip hop", energy: 0.55, valence: 0.3, languages },
];

console.log(`embedding pending songs…`);
await embedPending(() => {});

const f = (n: number | null) => (n == null ? "  - " : n.toFixed(2));
for (const mood of MOODS) {
  console.log(`\n== ${mood.description}  (e ${mood.energy}, v ${mood.valence})`);
  const exclude = new Set<string>();
  let target = { energy: mood.energy * 0.6 + 0.2, valence: 0.5 }; // start mid, ramp in
  let current: Candidate | undefined;
  for (let i = 0; i < 12; i++) {
    target = stepToward(target, { energy: mood.energy, valence: mood.valence });
    const cands = await pickCandidates({
      target: { ...mood, ...target },
      exclude,
      liked: new Set(),
      currentTempo: current?.tempo ?? null,
      limit: 20,
    });
    current = choose(cands);
    if (!current) break;
    exclude.add(current.id);
    console.log(
      `${String(i + 1).padStart(2)}  e ${f(current.energy)} v ${f(current.valence)} ${String(current.tempo ? Math.round(current.tempo) : "-").padStart(3)}bpm  ${current.era ?? "    "}  ${current.artist.split(",")[0]} – ${current.title}`,
    );
  }
}
await connection.quit();
process.exit(0);
