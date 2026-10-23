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
import {
  camelot,
  camelotLabel,
  EASE_BACK_S,
  keySteps,
  pairCost,
  type Schedule,
  songBeat,
  songLoudness,
  stretchPct,
  valueAt,
} from "@thej/mix";
import { apiGet, find, type LabSong, library } from "./data";
import { featuresIfReady, loadAudio, renderHandOver, SR, songFeatures, wavBytes } from "./render";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Rendered mixes by id, newest last; a handful is plenty for A/B listening. */
const wavs = new Map<string, Buffer>();
let seq = 0;

/** A schedule sampled at 20 Hz over [0, total] for drawing. */
const curve = (s: Schedule | undefined, total: number, initial: number) =>
  Array.from({ length: Math.ceil(total * 20) }, (_, i) =>
    s ? Math.round(valueAt(s, i / 20, initial) * 1000) / 1000 : initial,
  );

/**
 * The listener asked for `b` while `a` plays at `at` (s): choose the mix points from a few
 * seconds on (time to render and send), and render from just after `at` until `b` plays at
 * its own tempo again, so the page can splice it in and hand back to plain playback.
 */
async function transition(q: URLSearchParams) {
  const songs = await library();
  const a = find(songs, q.get("a") ?? "");
  const b = find(songs, q.get("b") ?? "");
  const at = Number(q.get("at") ?? 0);
  const r = await renderHandOver(a, b, {
    plan: { in: Number(q.get("in") ?? 16), out: Number(q.get("out") ?? 0) },
    mode: q.get("mode") === "analysed" ? "analysed" : "choose",
    style: (q.get("style") ?? "auto") as "auto" | "blend" | "filter" | "cut" | "echo",
    loop:
      Number(q.get("loop") ?? 8) > 0
        ? { beats: Number(q.get("loop") ?? 8), roll: q.get("roll") === "1" }
        : null,
    from: at + 5,
    startAt: at + 0.3,
    post: EASE_BACK_S + 3.5,
  });
  const id = String(++seq);
  wavs.set(id, wavBytes(r.mix));
  for (const k of wavs.keys()) if (wavs.size > 8) wavs.delete(k);
  const total = (r.mix[0]?.length ?? 0) / SR;
  const h = r.plan;
  return {
    wav: `/wav/${id}`,
    total,
    startAt: r.startAt,
    aLatencyS: r.aLatencyS,
    bHandOff: r.bHandOff,
    score: r.score,
    loop: h.outgoing?.loop ?? null,
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
    duration: s.durationS,
    mixOutS: s.mixOutS,
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
      if (url.pathname === "/transition") return json(res, await transition(url.searchParams));
      // A whole song as plain audio, decoded as the renders decode it, with its level trim.
      if (url.pathname === "/deck") {
        const song = find(await library(), url.searchParams.get("song") ?? "");
        const [x, f] = await Promise.all([loadAudio(song), songFeatures(song)]);
        const body = wavBytes(x);
        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": body.length,
          "X-Trim-Db": String(f.trimDb),
        });
        return res.end(body);
      }
      // The cached songs that would follow this one best (pairCost): close tempo first.
      if (url.pathname === "/matches") {
        const songs = await library();
        const a = find(songs, url.searchParams.get("song") ?? "");
        const aBeat = songBeat(a, "out");
        const ka = camelot(a.key, a.scale);
        const fa = await songFeatures(a);
        const rows = await Promise.all(
          songs
            .filter((b) => b !== a)
            .map(async (b) => {
              const bBeat = songBeat(b, "in");
              const kb = camelot(b.key, b.scale);
              // Level only when its audio has been analysed already (decoding is slow).
              const fb = featuresIfReady(b);
              const levelGapDb = fb
                ? songLoudness(fb.loud) + fb.trimDb - (songLoudness(fa.loud) + fa.trimDb)
                : undefined;
              const t = {
                stretchPct: aBeat && bBeat ? stretchPct(aBeat, bBeat) : 99,
                keySteps: ka && kb ? keySteps(ka, kb) : null,
                levelGapDb,
              };
              return { id: b.songId, ...t, cost: pairCost(t) };
            }),
        );
        return json(res, rows.sort((x, y) => x.cost - y.cost).slice(0, 8));
      }
      // Work out a song's beats and loudness ahead of its first transition.
      if (url.pathname === "/prepare") {
        await songFeatures(find(await library(), url.searchParams.get("song") ?? ""));
        return json(res, { ok: true });
      }
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
