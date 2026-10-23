import { readFile, writeFile } from "node:fs/promises";
import {
  apply,
  audioPeakDb,
  BASS_HZ,
  beatActivity,
  beatLoudness,
  camelot,
  camelotLabel,
  camelotShifted,
  chooseMixPoints,
  chooseStyle,
  type Features,
  fitToOnsets,
  type HandOver,
  keyShift,
  keySteps,
  LIMITER_INPUT,
  LIMITER_KNEE,
  type LoopStep,
  limiterCurve,
  MIX,
  matchRate,
  onGrid,
  type Plan,
  planHandOver,
  type Schedule,
  type StemInput,
  type Style,
  songBeat,
  songTrim,
  TAIL_BEATS,
  valueAt,
} from "@thej/mix";
import { OfflineAudioContext } from "node-web-audio-api";
import { audioPath, type LabSong } from "./data";
import { barLags, ENV_HZ, loudness, median, onsetEnvelope, peakDb } from "./metrics";
import { signalsmithDeck } from "./signalsmith";
import { type Stems, separate, stemEnvelopes, stemsAvailable } from "./stems";
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
      // Copied out: the views point into memory the decode context owns, which is reused once
      // it is collected (long benches rendered other songs' audio).
      return Array.from(
        { length: buf.numberOfChannels },
        (_, c) => new Float32Array(buf.getChannelData(c)),
      );
    })();
    decoded.set(song.songId, p);
  }
  return p;
}

/** A song's beats and the loudness of each, plus the level trim it plays with. */
export type SongFeatures = Features & { trimDb: number; onsets: Float64Array };
const features = new Map<string, Promise<SongFeatures>>();
export function songFeatures(song: LabSong): Promise<SongFeatures> {
  let p = features.get(song.songId);
  if (!p) {
    p = loadAudio(song)
      .then((x) => {
        const beats = song.beats ?? [];
        const loud = beatLoudness(x, SR, beats);
        return {
          beats,
          loud,
          duration: (x[0]?.length ?? 0) / SR,
          mixInS: song.mixInS,
          mixOutS: song.mixOutS,
          trimDb: songTrim(loud, audioPeakDb(x)),
          onsets: onsetEnvelope(x, SR),
        };
      })
      .then((f) => {
        ready.set(song.songId, f);
        return f;
      });
    features.set(song.songId, p);
  }
  return p;
}

/** A song's features if they have been worked out already, without starting the work. */
const ready = new Map<string, SongFeatures>();
export function featuresIfReady(song: LabSong): SongFeatures | undefined {
  return ready.get(song.songId);
}

export type RenderOptions = {
  plan?: Plan;
  /**
   * "choose" (default): wait for the best pair of mix points from `from` (chooseMixPoints).
   * "analysed": the server's mix-out and mix-in points, as the phone does today.
   */
  mode?: "choose" | "analysed";
  /** Outgoing song time the listener asks for the next song (default 30 s before its mix-out). */
  from?: number;
  maxWait?: number;
  /** Outgoing song time the render starts (default `pre` s before the mix). */
  startAt?: number;
  pre?: number;
  /** Seconds after the hand-over ends. */
  post?: number;
  /** Bring both songs to the same typical level (songTrim). Default on. */
  trim?: boolean;
  /** Loop the outgoing song from the mix point (planHandOver). Default 8 beats, no roll. */
  loop?: { beats: number; roll?: boolean } | null;
  /**
   * Shift the incoming song into a key that sits with the outgoing one. Off by default: the
   * phone's stretcher pitch-shifts music badly (about 5 dB of spectral error at 2 semitones,
   * against 1 dB for a 12% tempo change; Rohit heard it as "fully distorted").
   */
  keyMatch?: boolean;
  /**
   * What stretches the incoming deck: "phone" (default), react-native-audio-api's WSOLA as the
   * app has it today; "signalsmith", the library the app could ship (and key matching with it).
   */
  stretcher?: "phone" | "signalsmith";
  /** Hand over stem by stem (blend only); default on when the mix lab's Python is present. */
  stems?: boolean;
  /** How to switch; "auto" (default) lets chooseStyle pick from the pair. */
  style?: Style | "auto";
};

export type Score = {
  a: string;
  b: string;
  bpm: string;
  /** Incoming playback rate; 1 means the tempos were too far apart to match. */
  rate: number;
  keys: string;
  keySteps: number | null;
  /** Where the mix happens: outgoing and incoming song times (s), and the wait from `from`. */
  points: { mode: string; outS: number; inS: number; waitS: number };
  /** How it switched (chooseStyle, or as asked), and whether stem by stem. */
  style: Style;
  stems: boolean;
  /** Each song's level over the overlap and its trim (dB). */
  levels: { out: number | null; in: number | null; outTrim: number; inTrim: number };
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
  /** Share of the overlap (%) the limiter was rounding peaks off. */
  limitedPct: number;
  /** Loudness from the mix point to 4 s after it, against the 4 s before it (dB, 1 s steps). */
  loudness: { before: number; low: number; high: number };
  /** Render times (s from its start). */
  timeline: { when: number; swap: number; end: number; beat: number };
};

export type Render = {
  sampleRate: number;
  mix: Float32Array[];
  deckA: Float32Array[];
  deckB: Float32Array[];
  plan: HandOver;
  score: Score;
  /** Outgoing song time at render time 0, and how late its audio is (s): render time t plays
   * the outgoing song at startAt + t - aLatencyS (until the mix). */
  startAt: number;
  aLatencyS: number;
  /**
   * Where the render hands the incoming song back to plain playback: at render time `renderT`
   * (tempo eased back, so the stretcher passes it through unchanged) it plays the incoming song
   * at `songPos`, found by matching the samples. `match` near 1 means sample-exact.
   */
  bHandOff: { renderT: number; songPos: number; match: number } | null;
};

/**
 * The outgoing deck's audio as its buffer source reads it, from `startAt`, with the planned
 * loops: hard jumps at each wrap, as a looping AudioBufferSourceNode makes them.
 */
function withLoops(
  x: Float32Array[],
  startAt: number,
  frames: number,
  loop: { steps: LoopStep[]; releaseAt: number } | undefined,
): Float32Array[] {
  const start = Math.round(startAt * SR);
  if (!loop?.steps.length) return x.map((c) => c.subarray(start, start + frames));
  const out = x.map(() => new Float32Array(frames));
  const steps = loop.steps.map((s) => ({
    at: Math.round(s.at * SR),
    from: Math.round(s.startS * SR),
    len: Math.max(1, Math.round(s.lengthS * SR)),
  }));
  const release = Math.round(loop.releaseAt * SR);
  let k = 0;
  let pos = start;
  for (let f = 0; f < frames; f++) {
    const next = steps[k + 1];
    if (next && f >= next.at) k++;
    const st = steps[k] as { at: number; from: number; len: number };
    if (f < (steps[0] as { at: number }).at) pos = start + f;
    else if (f < release) pos = st.from + ((f - st.at) % st.len);
    else pos++;
    for (let c = 0; c < x.length; c++)
      (out[c] as Float32Array)[f] = ((x[c] as Float32Array)[pos] as number) ?? 0;
  }
  return out;
}

/** Where `seg` sits in `raw`, within `radius` frames of `guess` (normalised cross-correlation). */
function locate(raw: Float32Array, seg: Float32Array, guess: number, radius: number) {
  let segE = 0;
  for (const v of seg) segE += v * v;
  let best = { pos: guess, c: Number.NEGATIVE_INFINITY };
  for (
    let s = Math.max(0, guess - radius);
    s <= guess + radius && s + seg.length <= raw.length;
    s++
  ) {
    let dot = 0;
    let e = 0;
    for (let k = 0; k < seg.length; k++) {
      const r = raw[s + k] as number;
      dot += r * (seg[k] as number);
      e += r * r;
    }
    const c = dot / Math.sqrt(e * segE + 1e-12);
    if (c > best.c) best = { pos: s, c };
  }
  return best;
}

/**
 * One hand-over from `a` into `b`, as the phone would play it: A plays at its own tempo from
 * `startAt`, the mix timer fires on time, B comes in on A's beat at the chosen point. Both decks
 * go through the phone's stretcher, then the planned gains, bass shelves and master dip are
 * played by Web Audio.
 */
export async function renderHandOver(
  a: LabSong,
  b: LabSong,
  opts: RenderOptions = {},
): Promise<Render> {
  const [xa, xb, fa, fb] = await Promise.all([
    loadAudio(a),
    loadAudio(b),
    songFeatures(a),
    songFeatures(b),
  ]);
  const plan = opts.plan ?? MIX;
  const trim = opts.trim ?? true;
  const outTrim = trim ? fa.trimDb : 0;
  const inTrim = trim ? fb.trimDb : 0;
  const mode = opts.mode ?? "choose";
  const from = opts.from ?? Math.max(0, (a.mixOutS as number) - 30);
  // Vocal activity, once the song's stem envelopes have been worked out (stems.py envelopes).
  for (const [song, f] of [
    [a, fa],
    [b, fb],
  ] as const)
    if (!f.vocals) {
      const env = await stemEnvelopes(song);
      if (env) f.vocals = beatActivity(env.vocals, env.hz, f.beats);
    }
  // A stem hand-over replaces the loop (the stems would part from a looping song).
  const useStems = opts.stems ?? stemsAvailable();
  const loop = useStems ? null : opts.loop === undefined ? { beats: 8, roll: false } : opts.loop;
  const chosen =
    mode === "choose"
      ? chooseMixPoints(fa, fb, {
          from,
          maxWait: opts.maxWait,
          plan,
          outTrim,
          inTrim,
          loopBeats: loop?.beats ?? null,
        })
      : null;
  // Chosen points sit on the analysed beats; the grid there is then fitted to the audio, as the
  // server fits it at its own mix points.
  const span = plan.in + plan.out;
  const outFit =
    chosen &&
    fitToOnsets(fa.onsets, ENV_HZ, chosen.outS - 8 * chosen.outBeatS, chosen.outBeatS, span + 8);
  const inFit = chosen && fitToOnsets(fb.onsets, ENV_HZ, chosen.inS, chosen.inBeatS, span + 8);
  const outS = outFit ? outFit.t + 8 * outFit.beat : (a.mixOutS as number);
  const inOffset = inFit?.t ?? b.mixInS ?? 0;
  const beat = outFit?.beat ?? songBeat(a, "out") ?? 0.6;
  const inBeat = inFit?.beat ?? songBeat(b, "in");
  const startAt = Math.max(0, opts.startAt ?? outS - (opts.pre ?? 16));

  // MixerEngine.scheduleMix: wake a beat and 0.4 s early, then the mix beat itself (or the
  // next bar, if that moment has passed).
  const anchor = outS - startAt;
  const now = Math.max(0, anchor - beat - 0.4);
  const when = onGrid(anchor, beat * 4, now + beat + 0.05);
  const matchedRate = inBeat ? matchRate(beat, 1, inBeat) : 1;
  const ka = camelot(a.key, a.scale);
  const kb = camelot(b.key, b.scale);
  const style =
    opts.style && opts.style !== "auto"
      ? opts.style
      : chooseStyle({
          matched: matchedRate !== 1 || (inBeat != null && Math.abs(inBeat - beat) < 1e-4),
          keySteps: ka && kb ? keySteps(ka, kb) : null,
          levelJumpDb: chosen ? chosen.inAfterLoud - chosen.outLoud : 0,
        });
  // Stems for the stretch either side of the switch: the outgoing song from a beat before the
  // incoming one starts, the incoming one from its start, both past the end of the tail.
  let stemInput: StemInput | null = null;
  let stemAudio: { out: Stems; in: Stems | null } | null = null;
  if (useStems && style === "blend") {
    const inS = Math.min(14, plan.in * beat);
    const tailS = plan.out > 0 ? Math.min(8, plan.out * beat) : TAIL_BEATS * beat;
    const outStart = Math.max(0, startAt + when - beat - 0.5);
    const outLen = inS + tailS + 3 * beat + 1;
    // The incoming stems are split later, from the incoming deck as stretched and shifted:
    // each stem through a stretcher of its own would part from the others (heard as distortion
    // once the pitch moves).
    const inStart = inOffset;
    const inLen = (inS + tailS + 3 * beat) * matchedRate + 1;
    stemAudio = { out: await separate(a.songId, xa, SR, outStart, outLen), in: null };
    stemInput = {
      now: 0,
      outPosAt: (t) => startAt + t,
      outRateAt: () => 1,
      outStart,
      inStart,
      outLengths: { vocals: outLen, bass: outLen, rest: outLen },
      inLengths: { drums: inLen, other: inLen, rest: inLen },
    };
  }
  // Into a key that sits with the outgoing one (a semitone or two), eased back after.
  const shift = (opts.keyMatch ?? opts.stretcher === "signalsmith") ? keyShift(a, b) : 0;
  const h = planHandOver({
    when,
    plan,
    beat,
    rate: matchedRate,
    inOffset,
    master: 1,
    style,
    detune: shift * 100,
    stems: stemInput,
    loop,
    outPos: startAt + when,
    outRate: 1,
  });
  const rate = h.rate;

  const total = h.end + (opts.post ?? 16);
  const frames = Math.ceil(total * SR);
  const deckA = stretchDeck(
    withLoops(xa, startAt, frames, h.outgoing?.loop),
    0,
    frames,
    SR,
    () => 1,
  );
  const whenF = Math.round(when * SR);
  const ease = h.incoming.easeBack;
  const deckBRaw =
    opts.stretcher === "signalsmith"
      ? // Rendered by Signalsmith, then played at rate 1 through the phone's source as the app
        // would play a pre-stretched buffer (so it has the same start latency as deck A).
        stretchDeck(
          await signalsmithDeck(
            xb,
            Math.round(inOffset * SR),
            frames - whenF,
            SR,
            rate,
            h.incoming.detune / 100,
            ease ? (ease.at - when) * SR : 0,
            ease ? (ease.at + ease.dur - when) * SR : 0,
          ),
          0,
          frames - whenF,
          SR,
          () => 1,
        )
      : stretchDeck(
          xb,
          Math.round(inOffset * SR),
          frames - whenF,
          SR,
          (f) => (ease ? valueAt(ease.rate, when + f / SR, rate) : rate),
          (f) =>
            ease?.detune
              ? valueAt(ease.detune, when + f / SR, h.incoming.detune)
              : h.incoming.detune,
        );
  if (h.stems && stemAudio) {
    const len = Math.min(
      deckBRaw[0]?.length ?? 0,
      Math.round((h.stems.in.stopAt - when + 0.5) * SR),
    );
    stemAudio.in = await separate(
      `${b.songId}@${inOffset.toFixed(3)}:${rate}:${h.incoming.detune}`,
      deckBRaw.map((c) => c.subarray(0, len)),
      SR,
      0,
      len / SR,
    );
  }
  const deckB = deckBRaw.map((c) => {
    const full = new Float32Array(frames);
    full.set(c, whenF);
    return full;
  });

  const ctx = new OfflineAudioContext(2, frames, SR);
  const master = ctx.createGain();
  // The soft limiter the phone has on its master (planHandOver: no dip, peaks rounded off).
  const toShaper = ctx.createGain();
  toShaper.gain.value = LIMITER_INPUT;
  const limiter = ctx.createWaveShaper();
  limiter.curve = limiterCurve();
  master.connect(toShaper);
  toShaper.connect(limiter);
  limiter.connect(ctx.destination);
  const deck = (x: Float32Array[], trimDb: number) => {
    const buf = ctx.createBuffer(2, frames, SR);
    for (let c = 0; c < 2; c++)
      buf.copyToChannel(x[Math.min(c, x.length - 1)] as Float32Array<ArrayBuffer>, c);
    const source = ctx.createBufferSource();
    source.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowshelf";
    filter.frequency.value = BASS_HZ;
    filter.gain.value = 0;
    // The song's level trim, ahead of the planned gains.
    const level = ctx.createGain();
    level.gain.value = 10 ** (trimDb / 20);
    // Open until a filter-style switch sweeps them.
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 20;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 20000;
    const gain = ctx.createGain();
    source.connect(filter);
    filter.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(level);
    level.connect(gain);
    gain.connect(master);
    return { source, filter, highpass, lowpass, gain };
  };
  const A = deck(deckA, outTrim);
  const B = deck(deckB, inTrim);
  // Steps before the render starts (a filter sweep longer than the lead-in) start at 0.
  const at0 = (s: Schedule | undefined): Schedule | undefined =>
    s && {
      cancel: s.cancel == null ? undefined : Math.max(0, s.cancel),
      steps: s.steps.map((st) => ({ ...st, t: Math.max(0, st.t) })),
    };
  apply(master.gain, at0(h.master));
  apply(A.gain.gain, at0(h.outgoing?.gain));
  apply(A.filter.gain, at0(h.outgoing?.bass));
  apply(A.highpass.frequency, at0(h.outgoing?.highpass));
  apply(B.gain.gain, at0(h.incoming.gain));
  apply(B.filter.gain, at0(h.incoming.bass));
  apply(B.lowpass.frequency, at0(h.incoming.lowpass));
  const echo = h.outgoing?.echo;
  if (echo) {
    // The outgoing deck into a feedback delay, thinned so the echo sits behind the new song.
    const send = ctx.createGain();
    send.gain.value = 0;
    const delay = ctx.createDelay(2);
    delay.delayTime.value = echo.delayS;
    const feedback = ctx.createGain();
    feedback.gain.value = echo.feedback;
    const thin = ctx.createBiquadFilter();
    thin.type = "highpass";
    thin.frequency.value = 300;
    A.gain.connect(send);
    send.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(thin);
    thin.connect(master);
    apply(send.gain, at0(echo.send));
  }
  A.source.start(0);
  A.source.stop(h.outgoing?.stopAt ?? total);
  B.source.start(0);
  if (h.stems && stemAudio?.in) {
    // Each stem as a voice of its own with its deck's trim; the outgoing ones through the same
    // stretcher as their deck, the incoming ones already stretched (split from the deck).
    const parts = (st: Stems): Record<string, Float32Array[]> => ({
      drums: st.drums,
      bass: st.bass,
      other: st.other,
      vocals: st.vocals,
      // The parts the planner names "rest": the rest of each song, summed.
      outRest: st.drums.map((c, k) =>
        c.map((v, i) => v + ((st.other[k] as Float32Array)[i] as number)),
      ),
      inRest: st.bass.map((c, k) =>
        c.map((v, i) => v + ((st.vocals[k] as Float32Array)[i] as number)),
      ),
    });
    const voices = [
      { v: h.stems.out, p: parts(stemAudio.out), trimDb: outTrim, rest: "outRest", ready: false },
      { v: h.stems.in, p: parts(stemAudio.in), trimDb: inTrim, rest: "inRest", ready: true },
    ];
    for (const { v, p, trimDb, rest, ready } of voices)
      for (const [part, schedule] of Object.entries(v.gain) as [string, Schedule][]) {
        const src = p[part === "rest" ? rest : part];
        if (!src) continue;
        const at = Math.round(v.at * SR);
        const n = Math.max(1, Math.min(frames - at, Math.round((v.stopAt - v.at) * SR)));
        const played = ready
          ? src.map((c) => c.subarray(Math.round(v.offset * SR), Math.round(v.offset * SR) + n))
          : stretchDeck(src, Math.round(v.offset * SR), n, SR, () => v.rate);
        const buf = ctx.createBuffer(2, frames, SR);
        for (let c = 0; c < 2; c++) {
          const full = new Float32Array(frames);
          full.set(
            (played[Math.min(c, played.length - 1)] as Float32Array).subarray(0, frames - at),
            at,
          );
          buf.copyToChannel(full, c);
        }
        const source = ctx.createBufferSource();
        source.buffer = buf;
        const level = ctx.createGain();
        level.gain.value = 10 ** (trimDb / 20);
        const gain = ctx.createGain();
        gain.gain.value = 0;
        source.connect(level);
        level.connect(gain);
        gain.connect(master);
        apply(gain.gain, at0(schedule));
        source.start(0);
      }
  }
  const out = await ctx.startRendering();
  const mix = [0, 1].map((c) => new Float32Array(out.getChannelData(c)));

  let bHandOff: Render["bHandOff"] = null;
  const handT = h.end + (ease ? ease.dur : 0) + 1;
  if (handT + 0.2 < total) {
    // Song position by the planned tempo, then pinned to the sample by matching.
    const easeS = ease ? ease.dur : 0;
    const played = rate * (h.end - when) + ((rate + 1) / 2) * easeS + (handT - h.end - easeS);
    const guess = Math.round((inOffset + played) * SR) - deckBRaw.latency;
    const f = Math.round((handT - when) * SR);
    const seg = (deckBRaw[0] as Float32Array).subarray(f, f + 2048);
    const at = locate(xb[0] as Float32Array, seg, guess, Math.round(0.06 * SR));
    bHandOff = { renderT: handT, songPos: at.pos / SR, match: Math.round(at.c * 1e4) / 1e4 };
  }

  const envA = onsetEnvelope(deckA, SR);
  const envB = onsetEnvelope(deckB, SR);
  const bars = barLags(envA, envB, h.when, h.swap + h.outS, beat);
  const loud = loudness(mix, SR, Math.max(0, h.when - 4), Math.min(total, h.end + 4));
  const before = loud.slice(0, Math.min(4, Math.floor(h.when)));
  const during = loud.slice(before.length);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const overlap = (x: Float32Array[]) =>
    x.map((c) => c.subarray(Math.round(h.when * SR), Math.round(h.end * SR)));

  return {
    sampleRate: SR,
    mix,
    deckA,
    deckB,
    plan: h,
    startAt,
    aLatencyS: deckA.latency / SR,
    bHandOff,
    score: {
      a: `${a.title} · ${a.artist}`,
      b: `${b.title} · ${b.artist}`,
      bpm: `${r1(60 / beat)} → ${inBeat ? r1(60 / inBeat) : "?"}`,
      rate: Math.round(rate * 10000) / 10000,
      keys: `${camelotLabel(ka)} → ${camelotLabel(kb)}${
        h.incoming.detune
          ? ` (shifted ${h.incoming.detune > 0 ? "+" : ""}${h.incoming.detune / 100} st)`
          : ""
      }`,
      // As heard: after the key shift, if any.
      keySteps: (() => {
        const heard = camelotShifted(b.key, b.scale, h.incoming.detune / 100);
        return ka && heard ? keySteps(ka, heard) : null;
      })(),
      style: h.style,
      stems: Boolean(h.stems),
      points: {
        mode: chosen ? "chosen" : "analysed",
        outS: r1(startAt + when),
        inS: r1(inOffset),
        waitS: r1(Math.max(0, startAt + when - from)),
      },
      levels: {
        out: chosen ? r1(chosen.outLoud) : null,
        in: chosen ? r1(chosen.inLoud) : null,
        outTrim: r1(outTrim),
        inTrim: r1(inTrim),
      },
      lagMs: bars.length ? median(bars) : null,
      // Second half of the overlap against the first: one bar locking off-beat doesn't move it.
      driftMs:
        bars.length > 1
          ? median(bars.slice(bars.length >> 1)) - median(bars.slice(0, bars.length >> 1))
          : null,
      bars,
      startLatencyMs: {
        a: Math.round((deckA.latency / SR) * 1000),
        b: Math.round((deckBRaw.latency / SR) * 1000),
      },
      peakDb: r1(peakDb(overlap(mix))),
      deckPeakDb: r1(Math.max(peakDb(overlap(deckA)), peakDb(overlap(deckB)))),
      limitedPct: r1(limitedShare(overlap(mix))),
      loudness: {
        before: r1(before.reduce((s, v) => s + v, 0) / Math.max(1, before.length)),
        // Over two seconds, so one quiet beat doesn't read as a hole.
        low: r1(
          Math.min(
            ...during.slice(1).map((v, i) => ((during[i] as number) + v) / 2),
            ...(during.length < 2 ? during : []),
          ),
        ),
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

function limitedShare(x: Float32Array[]): number {
  let over = 0;
  let n = 0;
  for (const ch of x)
    for (const v of ch) {
      n++;
      if (Math.abs(v) > LIMITER_KNEE) over++;
    }
  return n ? (100 * over) / n : 0;
}

/** A copy of `x` fading to silence over its last `s` seconds, so a render doesn't end mid-song. */
export function fadeOut(x: Float32Array[], s: number, sampleRate = SR): Float32Array[] {
  return x.map((c) => {
    const y = new Float32Array(c);
    const n = Math.min(y.length, Math.round(s * sampleRate));
    for (let i = 0; i < n; i++) {
      const k = y.length - n + i;
      y[k] = (y[k] as number) * (1 - i / n) ** 2;
    }
    return y;
  });
}

export async function writeWav(path: string, x: Float32Array[], sampleRate = SR) {
  await writeFile(path, wavBytes(x, sampleRate));
}

/** 16-bit stereo WAV. */
export function wavBytes(x: Float32Array[], sampleRate = SR): Buffer {
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
  return buf;
}
