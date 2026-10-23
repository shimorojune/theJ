import { readFile, writeFile } from "node:fs/promises";
import {
  apply,
  BASS_HZ,
  camelot,
  camelotLabel,
  type HandOver,
  keySteps,
  MIX,
  matchRate,
  onGrid,
  type Plan,
  planHandOver,
  songBeat,
  valueAt,
} from "@thej/mix";
import { OfflineAudioContext } from "node-web-audio-api";
import { audioPath, type LabSong } from "./data";
import { barLags, loudness, median, onsetEnvelope, peakDb } from "./metrics";
import { stretchDeck } from "./wsola";

/** Android's usual output rate; the phone's AudioContext runs at the device rate. */
export const SR = 48000;

const decoded = new Map<string, Promise<Float32Array[]>>();

/** A song's audio decoded at SR (node-web-audio-api's decoder, not the phone's). */
export function loadAudio(song: LabSong): Promise<Float32Array[]> {
  let p = decoded.get(song.songId);
  if (!p) {
    p = (async () => {
      const bytes = await readFile(audioPath(song));
      const ctx = new OfflineAudioContext(2, 1, SR);
      const buf = await ctx.decodeAudioData(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
      return Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
    })();
    decoded.set(song.songId, p);
  }
  return p;
}

export type RenderOptions = {
  plan?: Plan;
  /** Seconds of the outgoing song before the mix, and of the incoming one after it. */
  pre?: number;
  post?: number;
};

export type Score = {
  a: string;
  b: string;
  bpm: string;
  /** Incoming playback rate; 1 means the tempos were too far apart to match. */
  rate: number;
  keys: string;
  keySteps: number | null;
  /** Median lag of B's beats behind A's over the overlap (ms), drift first bar to last, per bar. */
  lagMs: number | null;
  driftMs: number | null;
  bars: number[];
  /** How late each deck's audio starts after it is told to (the stretcher's warm-up). */
  startLatencyMs: { a: number; b: number };
  /** Loudest sample while both decks play (dBFS); over 0 clips. */
  peakDb: number;
  /** The louder deck's own peak over the same stretch: above 0 means the song itself is hot. */
  deckPeakDb: number;
  /** Loudness from the mix point to 4 s after it, against the 4 s before it (dB, 1 s steps). */
  loudness: { before: number; low: number; high: number };
  timeline: { when: number; swap: number; end: number; beat: number };
};

export type Render = {
  sampleRate: number;
  mix: Float32Array[];
  deckA: Float32Array[];
  deckB: Float32Array[];
  plan: HandOver;
  score: Score;
};

/**
 * One hand-over from `a` into `b`, as the phone plays it at the end of a song: A plays at its
 * own tempo, the mix timer fires on time, B comes in on A's mix-out beat. Both decks go through
 * the phone's stretcher, then the planned gains, bass shelves and master dip are played by Web
 * Audio. Time 0 is `pre` seconds before A's mix-out.
 */
export async function renderHandOver(
  a: LabSong,
  b: LabSong,
  opts: RenderOptions = {},
): Promise<Render> {
  const [xa, xb] = await Promise.all([loadAudio(a), loadAudio(b)]);
  const pre = Math.min(opts.pre ?? 16, a.mixOutS as number);
  const post = opts.post ?? 16;
  const posA0 = (a.mixOutS as number) - pre;

  // MixerEngine.scheduleMix: wake a beat and 0.4 s early, then the mix-out beat itself.
  const beat = songBeat(a, "out") ?? 0.6;
  const anchor = pre;
  const now = anchor - beat - 0.4;
  const when = onGrid(anchor, beat * 4, now + beat + 0.05);
  const inBeat = songBeat(b, "in");
  const rate = inBeat ? matchRate(beat, 1, inBeat) : 1;
  const inOffset = b.mixInS ?? 0;
  const h = planHandOver({ when, plan: opts.plan ?? MIX, beat, rate, inOffset, master: 1 });

  const total = h.end + post;
  const frames = Math.ceil(total * SR);
  const deckA = stretchDeck(xa, Math.round(posA0 * SR), frames, SR, () => 1);
  const whenF = Math.round(when * SR);
  const ease = h.incoming.easeBack;
  const deckBRaw = stretchDeck(xb, Math.round(inOffset * SR), frames - whenF, SR, (f) =>
    ease ? valueAt(ease.rate, when + f / SR, rate) : rate,
  );
  const deckB = deckBRaw.map((c) => {
    const full = new Float32Array(frames);
    full.set(c, whenF);
    return full;
  });

  const ctx = new OfflineAudioContext(2, frames, SR);
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const deck = (x: Float32Array[]) => {
    const buf = ctx.createBuffer(2, frames, SR);
    for (let c = 0; c < 2; c++)
      buf.copyToChannel(x[Math.min(c, x.length - 1)] as Float32Array<ArrayBuffer>, c);
    const source = ctx.createBufferSource();
    source.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowshelf";
    filter.frequency.value = BASS_HZ;
    filter.gain.value = 0;
    const gain = ctx.createGain();
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    return { source, filter, gain };
  };
  const A = deck(deckA);
  const B = deck(deckB);
  apply(master.gain, h.master);
  apply(A.gain.gain, h.outgoing?.gain);
  apply(A.filter.gain, h.outgoing?.bass);
  apply(B.gain.gain, h.incoming.gain);
  apply(B.filter.gain, h.incoming.bass);
  A.source.start(0);
  A.source.stop(h.outgoing?.stopAt ?? total);
  B.source.start(0);
  const out = await ctx.startRendering();
  const mix = [out.getChannelData(0), out.getChannelData(1)];

  const envA = onsetEnvelope(deckA, SR);
  const envB = onsetEnvelope(deckB, SR);
  const bars = barLags(envA, envB, h.when, h.swap + h.outS, beat);
  const ka = camelot(a.key, a.scale);
  const kb = camelot(b.key, b.scale);
  const loud = loudness(mix, SR, Math.max(0, h.when - 4), Math.min(total, h.end + 4));
  const before = loud.slice(0, 4);
  const during = loud.slice(4);
  const lead = (x: Float32Array[]) => {
    const ch = x[0] as Float32Array;
    let i = 0;
    while (i < ch.length && Math.abs(ch[i] as number) < 1e-6) i++;
    return Math.round((i / SR) * 1000);
  };
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const overlap = (x: Float32Array[]) =>
    x.map((c) => c.subarray(Math.round(h.when * SR), Math.round(h.end * SR)));

  return {
    sampleRate: SR,
    mix,
    deckA,
    deckB,
    plan: h,
    score: {
      a: `${a.title} · ${a.artist}`,
      b: `${b.title} · ${b.artist}`,
      bpm: `${r1(60 / beat)} → ${inBeat ? r1(60 / inBeat) : "?"}`,
      rate: Math.round(rate * 10000) / 10000,
      keys: `${camelotLabel(ka)} → ${camelotLabel(kb)}`,
      keySteps: ka && kb ? keySteps(ka, kb) : null,
      lagMs: bars.length ? median(bars) : null,
      // Second half of the overlap against the first: one bar locking off-beat doesn't move it.
      driftMs:
        bars.length > 1
          ? median(bars.slice(bars.length >> 1)) - median(bars.slice(0, bars.length >> 1))
          : null,
      bars,
      startLatencyMs: { a: lead(deckA), b: lead(deckBRaw) },
      peakDb: r1(peakDb(overlap(mix))),
      deckPeakDb: r1(Math.max(peakDb(overlap(deckA)), peakDb(overlap(deckB)))),
      loudness: {
        before: r1(before.reduce((s, v) => s + v, 0) / Math.max(1, before.length)),
        low: r1(Math.min(...during)),
        high: r1(Math.max(...during)),
      },
      timeline: {
        when: r1(h.when),
        swap: r1(h.swap),
        end: r1(h.end),
        beat: Math.round(beat * 1e4) / 1e4,
      },
    },
  };
}

/** 16-bit stereo WAV. */
export async function writeWav(path: string, x: Float32Array[], sampleRate = SR) {
  const n = x[0]?.length ?? 0;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 2; c++) {
      const v = Math.max(
        -1,
        Math.min(1, (x[Math.min(c, x.length - 1)] as Float32Array)[i] as number),
      );
      buf.writeInt16LE(Math.round(v * 32767), 44 + i * 4 + c * 2);
    }
  await writeFile(path, buf);
}
