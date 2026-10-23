/**
 * The DJ lab in a browser (`pnpm mix lab`): pick two cached songs, change the plan, hear the
 * hand-over and see its schedules and score. Every render is the same one the CLI does (the
 * phone's stretcher, then Web Audio), made here and played back as a WAV, so what you hear is
 * what the metrics measured.
 */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { camelot, camelotLabel, type Schedule, songBeat, valueAt } from "@thej/mix";
import { apiGet, find, type LabSong, library } from "./data";
import { renderHandOver, SR, wavBytes } from "./render";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Rendered mixes by id, newest last; a handful is plenty for A/B listening. */
const wavs = new Map<string, Buffer>();
let seq = 0;

/** A schedule sampled at 20 Hz over [0, total] for drawing. */
const curve = (s: Schedule | undefined, total: number, initial: number) =>
  Array.from({ length: Math.ceil(total * 20) }, (_, i) =>
    s ? Math.round(valueAt(s, i / 20, initial) * 1000) / 1000 : initial,
  );

async function render(q: URLSearchParams) {
  const songs = await library();
  const a = find(songs, q.get("a") ?? "");
  const b = find(songs, q.get("b") ?? "");
  const r = await renderHandOver(a, b, {
    plan: { in: Number(q.get("in") ?? 16), out: Number(q.get("out") ?? 8) },
    pre: Number(q.get("pre") ?? 12),
    post: Number(q.get("post") ?? 12),
  });
  const id = String(++seq);
  wavs.set(id, wavBytes(r.mix));
  for (const k of wavs.keys()) if (wavs.size > 8) wavs.delete(k);
  const total = (r.mix[0]?.length ?? 0) / SR;
  const h = r.plan;
  return {
    wav: `/wav/${id}`,
    total,
    score: r.score,
    curves: {
      aGain: curve(h.outgoing?.gain, total, 1),
      bGain: curve(h.incoming.gain, total, 0).map((v, i) => (i / 20 < h.when ? 0 : v)),
      aBass: curve(h.outgoing?.bass, total, 0),
      bBass: curve(h.incoming.bass, total, 0),
      master: curve(h.master, total, 1),
    },
  };
}

/** What the page needs to list a song and find pairs worth trying. */
function songRow(s: LabSong) {
  return {
    id: s.songId,
    title: s.title,
    artist: s.artist,
    bpm: s.bpm,
    key: camelotLabel(camelot(s.key, s.scale)),
    inBeat: songBeat(s, "in"),
    outBeat: songBeat(s, "out"),
  };
}

const json = (res: import("node:http").ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

export function serve(port: number) {
  createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(await readFile(join(HERE, "page.html")));
      }
      if (url.pathname === "/songs") return json(res, (await library()).map(songRow));
      if (url.pathname === "/render") return json(res, await render(url.searchParams));
      if (url.pathname === "/pick") {
        const q = new URLSearchParams({
          text: url.searchParams.get("text") ?? "dance party",
          lang: url.searchParams.get("lang") ?? "en,hi",
        });
        const picks = await apiGet<{
          artists: string[];
          picks: { title: string; artist: string }[];
        }>(`/lab/pick?${q}`).catch((e: Error) => {
          throw e.message.includes(" 404")
            ? new Error("The api on the VPS has no /lab/pick yet: its deploys since 22 Oct failed.")
            : e;
        });
        const cached = new Set((await library()).map((s) => s.title.toLowerCase()));
        return json(res, {
          ...picks,
          picks: picks.picks.map((p) => ({ ...p, cached: cached.has(p.title.toLowerCase()) })),
        });
      }
      const wav = /^\/wav\/(\d+)$/.exec(url.pathname);
      const body = wav ? wavs.get(wav[1] as string) : undefined;
      if (body) {
        res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": body.length });
        return res.end(body);
      }
      json(res, { error: "not found" }, 404);
    } catch (e) {
      json(res, { error: (e as Error).message }, 400);
    }
  }).listen(port, "127.0.0.1", () => console.log(`DJ lab on http://localhost:${port}`));
}
