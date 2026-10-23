/**
 * The DJ lab, from the terminal: render the phone's hand-overs offline and score them.
 *
 *   pnpm mix fetch [--limit 60]          pulled songs + analysis from the api, audio cached locally
 *   pnpm mix list [words]              cached songs that can be mixed
 *   pnpm mix render <A> <B> [--plan 16/8] [--pre 16] [--post 16]
 *                                      one hand-over to apps/lab/out/<A>__<B>.wav, plus its score
 *   pnpm mix bench [--n 20]            score many tempo-matchable pairs, write out/bench.md
 *   pnpm mix lab [--port 4400]         the same in a browser: pick pairs, change the plan, listen
 *
 * A and B are song ids or words from the title/artist. Env: THEJ_API, THEJ_DEV_TOKEN (falls
 * back to apps/mobile/.env), THEJ_DEV_USER.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { camelot, keySteps, MAX_TEMPO_STRETCH, matchRate, songBeat } from "@thej/mix";
import { fetchSongs, find, type LabSong, library, OUT } from "./data";
import { renderHandOver, type Score, writeWav } from "./render";
import { serve } from "./server";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: "string", default: "60" },
    plan: { type: "string", default: "16/8" },
    pre: { type: "string", default: "16" },
    post: { type: "string", default: "16" },
    n: { type: "string", default: "20" },
    json: { type: "boolean", default: false },
    port: { type: "string", default: "4400" },
  },
});
const [cmd, ...args] = positionals;
const slug = (s: LabSong) => s.songId.replace(/[^A-Za-z0-9_-]/g, "_");

function planOf(text: string) {
  const [i, o] = text.split("/").map(Number);
  if (!i || !o) throw new Error(`--plan is beats in/out, e.g. 16/8 (got ${text})`);
  return { in: i, out: o };
}

function show(s: Score) {
  const ms = (v: number | null) => (v == null ? "-" : `${v > 0 ? "+" : ""}${v} ms`);
  const flam = s.lagMs == null ? "" : Math.abs(s.lagMs) <= 20 ? "  tight" : "  flams (over 20 ms)";
  console.log(`${s.a}\n  → ${s.b}`);
  console.log(
    `  tempo   ${s.bpm} bpm, rate ${s.rate}${s.rate === 1 ? " (not matched)" : ` (${((s.rate - 1) * 100).toFixed(1)}%)`}`,
  );
  console.log(
    `  key     ${s.keys}${s.keySteps == null ? "" : s.keySteps <= 1 ? "  compatible" : `  ${s.keySteps} steps apart, clashes`}`,
  );
  console.log(`  beats   ${ms(s.lagMs)} median, drift ${ms(s.driftMs)}${flam}`);
  console.log(`          per bar: ${s.bars.map((b) => `${b}`).join(" ")}`);
  const dip = s.loudness.before - s.loudness.low;
  console.log(
    `  level   ${s.loudness.before} dB before, ${s.loudness.low} to ${s.loudness.high} dB through it${dip >= 6 ? `  drops ${dip.toFixed(0)} dB` : ""}`,
  );
  console.log(
    `  peak    ${s.peakDb} dBFS while both play (louder deck alone ${s.deckPeakDb})${s.peakDb > 0 ? "  clips" : ""}`,
  );
  console.log(
    `  start   A ${s.startLatencyMs.a} ms, B ${s.startLatencyMs.b} ms late (stretcher warm-up)`,
  );
  console.log(
    `  plan    B in at ${s.timeline.when}s, bass swap ${s.timeline.swap}s, A gone ${s.timeline.end}s, beat ${s.timeline.beat}s`,
  );
}

async function main() {
  if (cmd === "fetch") return fetchSongs(Number(values.limit));
  if (cmd === "lab") return serve(Number(values.port));
  const songs = await library();
  if (cmd === "list") {
    const q = args.join(" ").toLowerCase();
    for (const s of songs)
      if (!q || `${s.title} ${s.artist}`.toLowerCase().includes(q))
        console.log(
          `${s.songId.padEnd(26)} ${(s.bpm ?? 0).toFixed(1).padStart(6)} ${(s.key ?? "?").padEnd(3)} ${s.title} · ${s.artist}`,
        );
    return;
  }
  await mkdir(OUT, { recursive: true });
  const opts = { plan: planOf(values.plan), pre: Number(values.pre), post: Number(values.post) };
  if (cmd === "render") {
    const [qa, qb] = args;
    if (!qa || !qb) throw new Error("render <A> <B>");
    const a = find(songs, qa);
    const b = find(songs, qb);
    const r = await renderHandOver(a, b, opts);
    const path = join(OUT, `${slug(a)}__${slug(b)}.wav`);
    await writeWav(path, r.mix);
    if (values.json) console.log(JSON.stringify(r.score));
    else show(r.score);
    console.log(`  wav     ${path}`);
    return;
  }
  if (cmd === "bench") {
    // Pairs a DJ would try: close enough in tempo to match, keys not far apart.
    const pairs: [LabSong, LabSong][] = [];
    for (const a of songs)
      for (const b of songs) {
        const ba = songBeat(a, "out");
        const bb = songBeat(b, "in");
        const ka = camelot(a.key, a.scale);
        const kb = camelot(b.key, b.scale);
        if (a === b || !ba || !bb || matchRate(ba, 1, bb) === 1) continue;
        if (ka && kb && keySteps(ka, kb) > 2) continue;
        pairs.push([a, b]);
      }
    const n = Number(values.n);
    const pick = pairs
      .filter((_, i) => i % Math.max(1, Math.floor(pairs.length / n)) === 0)
      .slice(0, n);
    const rows: Score[] = [];
    for (const [a, b] of pick) {
      try {
        const r = await renderHandOver(a, b, { ...opts, post: 5 });
        rows.push(r.score);
        console.error(`${r.score.lagMs} ms  ${a.title} → ${b.title}`);
      } catch (e) {
        console.error(`skip ${a.title} → ${b.title}: ${(e as Error).message}`);
      }
    }
    const lags = rows.flatMap((r) => (r.lagMs == null ? [] : [Math.abs(r.lagMs)]));
    const tight = lags.filter((l) => l <= 20).length;
    const sorted = [...lags].sort((x, y) => x - y);
    const lines = [
      `# Mix bench: ${rows.length} tempo-matched pairs (within ${MAX_TEMPO_STRETCH * 100}%)`,
      "",
      `Beats within 20 ms: ${tight} of ${lags.length}. Median |lag| ${sorted[sorted.length >> 1] ?? "-"} ms.`,
      "",
      "| A | B | BPM | rate | keys | lag ms | drift ms | level during |",
      "|---|---|---|---|---|---|---|---|",
      ...rows.map(
        (r) =>
          `| ${r.a} | ${r.b} | ${r.bpm} | ${r.rate} | ${r.keys} | ${r.lagMs} | ${r.driftMs} | ${r.loudness.low}..${r.loudness.high} dB |`,
      ),
    ];
    await writeFile(join(OUT, "bench.md"), `${lines.join("\n")}\n`);
    console.log(lines.slice(0, 3).join("\n"));
    console.log(`  ${join(OUT, "bench.md")}`);
    return;
  }
  console.log("usage: pnpm mix fetch | list [words] | render <A> <B> | bench | lab");
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
