/**
 * Drive a session from the terminal (dev auth). Usage:
 *   pnpm cli start [en,hi] [energy] [valence]   start a party
 *   pnpm cli queue                              now playing, next 2, and the projected plan
 *   pnpm cli hype|chill|brighter|moodier [now]  vibe buttons ("now" = long press)
 *   pnpm cli done|skip|like                     events for the current song
 *   pnpm cli play [n]                           finish n songs in a row, showing the ramp
 *   pnpm cli audio                              range-request the current song's signed URL
 *   pnpm cli watch                              follow the SSE stream
 */
import { readFile, writeFile } from "node:fs/promises";
import { Button } from "@thej/shared";
import { hc } from "hono/client";
import type { AppType } from "./app";

const base = process.env.API_URL ?? "http://localhost:3000";
const headers = { "x-dev-user": process.env.CLI_USER ?? "cli" };
const api = hc<AppType>(base, { headers });
const stateFile = new URL("../.cli-session", import.meta.url);

type Song = {
  videoId: string;
  title: string;
  artist: string;
  energy: number | null;
  valence: number | null;
  tempo: number | null;
};
type Q = {
  sessionId: string;
  committed: Song[];
  goal: { energy: number; valence: number };
  target: { energy: number; valence: number };
  skipTo?: string;
  upcoming?: Song[];
};

const f = (n: number | null | undefined) => (n == null ? "  -  " : n.toFixed(2));
const line = (s: Song) =>
  `e ${f(s.energy)}  v ${f(s.valence)}  ${String(s.tempo ?? "-").padStart(3)} bpm  ${s.artist.split(",")[0]} – ${s.title}`;

function show(q: Q) {
  console.log(`goal   e ${f(q.goal.energy)}  v ${f(q.goal.valence)}`);
  console.log(`target e ${f(q.target.energy)}  v ${f(q.target.valence)}`);
  for (const [i, s] of q.committed.entries())
    console.log(`${i === 0 ? "▶ now " : `  +${i}  `} ${line(s)}`);
  if (q.skipTo) console.log(`  (app skips to ${q.skipTo})`);
  for (const [i, s] of (q.upcoming ?? []).entries()) console.log(`  ~${i + 3}  ${line(s)}`);
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

const sessionId = async () => (await readFile(stateFile, "utf8")).trim();
const current = async (id: string) =>
  await json<Q>(await api.sessions[":id"].$get({ param: { id } }));

const [cmd = "queue", ...args] = process.argv.slice(2);

if (cmd === "start") {
  const languages = (args[0] ?? "en,hi").split(",") as ("en" | "hi")[];
  const vibe = { energy: Number(args[1] ?? 0.5), valence: Number(args[2] ?? 0.5) };
  const q = await json<Q>(await api.sessions.$post({ json: { languages, vibe } }));
  await writeFile(stateFile, q.sessionId);
  console.log(`session ${q.sessionId}`);
  show(q);
} else if (cmd === "queue") {
  show(await current(await sessionId()));
} else if (Button.safeParse(cmd).success) {
  const id = await sessionId();
  const res = await api.sessions[":id"].control.$post({
    param: { id },
    json: { kind: "button", button: cmd as Button, now: args[0] === "now" },
  });
  show(await json<Q>(res));
} else if (cmd === "done" || cmd === "skip" || cmd === "like") {
  const id = await sessionId();
  const now = (await current(id)).committed[0];
  if (!now) throw new Error("nothing playing");
  const event = cmd === "done" ? "complete" : cmd;
  const res = await api.sessions[":id"].events.$post({
    param: { id },
    json: { videoId: now.videoId, event },
  });
  if (res.status === 204) console.log(`liked ${now.title}`);
  else show(await json<Q>(res));
} else if (cmd === "play") {
  const id = await sessionId();
  for (let i = 0; i < Number(args[0] ?? 5); i++) {
    const now = (await current(id)).committed[0];
    if (!now) break;
    await api.sessions[":id"].events.$post({
      param: { id },
      json: { videoId: now.videoId, event: "start" },
    });
    const q = await json<Q>(
      await api.sessions[":id"].events.$post({
        param: { id },
        json: { videoId: now.videoId, event: "complete" },
      }),
    );
    console.log(
      `played ${line(now)}\n        target now e ${f(q.target.energy)} v ${f(q.target.valence)}`,
    );
  }
} else if (cmd === "audio") {
  const id = await sessionId();
  const res = await fetch(`${base}/sessions/${id}`, { headers });
  const now = (await json<Q & { committed: (Song & { audioUrl: string })[] }>(res)).committed[0];
  if (!now) throw new Error("nothing playing");
  const a = await fetch(now.audioUrl, { headers: { Range: "bytes=0-1023" } });
  console.log(
    a.status,
    a.headers.get("content-type"),
    a.headers.get("content-range"),
    `${(await a.arrayBuffer()).byteLength} bytes`,
  );
  const bad = await fetch(now.audioUrl.replace(/sig=[^&]+/, "sig=forged"));
  console.log("forged signature ->", bad.status);
} else if (cmd === "watch") {
  const id = await sessionId();
  const res = await fetch(`${base}/sessions/${id}/stream`, { headers });
  const reader = (res.body as ReadableStream<Uint8Array>)
    .pipeThrough(new TextDecoderStream())
    .getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const m of value.matchAll(/event: queue\ndata: (.*)\n/g)) {
      console.log(`--- ${new Date().toLocaleTimeString()}`);
      show(JSON.parse(m[1] as string));
    }
  }
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(1);
}
process.exit(0);
