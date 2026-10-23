/**
 * Where to mix: instead of always handing over at the analysed mix-out and starting the next
 * song at its intro, find the pair of points (one in each song, both on a phrase) where the two
 * songs are equally loud and their beats are steady, and wait for it. The listener asks for the
 * next song; the DJ picks the moment.
 */
import { matchRate, type Plan, type Style } from "./plan";

/** What the chooser knows about a song: its beat times and how loud each beat is. */
export type Features = {
  /** Beat times (s), as analysed. */
  beats: number[];
  /** Loudness of each beat (dB RMS over the beat), from beatLoudness. */
  loud: number[];
  duration: number;
  mixInS?: number | null;
  mixOutS?: number | null;
};

export type ChooseOptions = {
  /** The earliest point in the outgoing song the mix can start (s). */
  from: number;
  /** Longest wait for a better point (s of the outgoing song). */
  maxWait?: number;
  plan: Plan;
  /** Level trims (dB) each song plays with (songTrim), so loudness is compared as heard. */
  outTrim?: number;
  inTrim?: number;
  /**
   * The outgoing song loops this many beats from the mix point (planHandOver's loop): only that
   * stretch of it needs to be steady and as loud, and it needs no song left after it.
   */
  loopBeats?: number | null;
};

export type MixPoints = {
  /** Outgoing song time the incoming song comes in, and the incoming song's start time (s). */
  outS: number;
  inS: number;
  /** Beat length (s) of each song over the mix, fitted to its beats there. */
  outBeatS: number;
  inBeatS: number;
  /** How long the listener waits from `from` (s). */
  waitS: number;
  /** Loudness (dB, trims included) of each song over the overlap. */
  outLoud: number;
  inLoud: number;
  /** The incoming song's level (dB, trimmed) on its own just after the switch. */
  inAfterLoud: number;
  /** Beat wobble (ms, RMS off a straight grid) over each window. */
  outJitterMs: number;
  inJitterMs: number;
  cost: number;
};

/** A phrase is 16 beats; mix points stay on the analysed mix points' phrase grid. */
const PHRASE = 16;

/**
 * Loudness of each beat: dB RMS of the audio between it and the next beat. Pure arithmetic on
 * the decoded audio, so the phone can work it out from its own buffer.
 */
export function beatLoudness(
  channels: Float32Array[],
  sampleRate: number,
  beats: number[],
): number[] {
  const len = channels[0]?.length ?? 0;
  return beats.map((t, i) => {
    const a = Math.max(0, Math.floor(t * sampleRate));
    const next = beats[i + 1] ?? t + ((beats[i] ?? t) - (beats[i - 1] ?? t - 0.5));
    const b = Math.min(len, Math.floor(next * sampleRate));
    let sum = 0;
    for (const ch of channels) for (let k = a; k < b; k += 4) sum += (ch[k] as number) ** 2;
    const n = Math.max(1, Math.ceil((b - a) / 4) * channels.length);
    return 10 * Math.log10(sum / n + 1e-10);
  });
}

/** Typical level a song's beats sit at (dB): the median, so breakdowns and silences don't count. */
export function songLoudness(loud: number[]): number {
  const s = loud.filter((v) => v > -60).sort((x, y) => x - y);
  return s.length ? (s[s.length >> 1] as number) : -20;
}

/**
 * Every song is brought to the same typical level, within limits: never more than 9 dB down or
 * 4 dB up, and never so far up that its loudest sample passes -1 dBFS.
 */
export const TARGET_LOUD_DB = -12;
export function songTrim(loud: number[], peakDb = 0): number {
  return Math.max(-9, Math.min(4, -1 - peakDb, TARGET_LOUD_DB - songLoudness(loud)));
}

/** Loudest sample of the decoded audio (dBFS). */
export function audioPeakDb(channels: Float32Array[]): number {
  let p = 0;
  for (const ch of channels)
    for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i] as number));
  return 20 * Math.log10(p + 1e-12);
}

/**
 * Straight line through beats[i0..i1): where it puts beat `at`, its beat length and the RMS
 * wobble off it (ms). Mixing on the line rather than on one analysed beat averages out that
 * beat's own error.
 */
function fitGrid(
  beats: number[],
  i0: number,
  i1: number,
  at: number,
): { t: number; beat: number; jitterMs: number } {
  const n = i1 - i0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let k = 0; k < n; k++) {
    const y = beats[i0 + k] as number;
    sx += k;
    sy += y;
    sxx += k * k;
    sxy += k * y;
  }
  const beat = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const t0 = (sy - beat * sx) / n;
  let e = 0;
  for (let k = 0; k < n; k++) e += ((beats[i0 + k] as number) - (t0 + beat * k)) ** 2;
  return { t: t0 + beat * (at - i0), beat, jitterMs: Math.sqrt(e / n) * 1000 };
}

const mean = (xs: number[], i0: number, i1: number) => {
  let s = 0;
  let n = 0;
  for (let i = Math.max(0, i0); i < Math.min(xs.length, i1); i++) {
    s += xs[i] as number;
    n++;
  }
  return n ? s / n : -60;
};

const nearest = (beats: number[], t: number) => {
  let best = 0;
  for (let i = 1; i < beats.length; i++)
    if (Math.abs((beats[i] as number) - t) < Math.abs((beats[best] as number) - t)) best = i;
  return best;
};

/**
 * The best pair of mix points: the outgoing point within `maxWait` of `from`, the incoming one
 * in the first 60% of the song, both on their song's phrase grid. Cost, in dB-like units:
 *   loudness gap between the songs over the overlap (trims included)
 *   + either song sitting well below its own usual level there (two matching breakdowns are
 *     equally loud, but the floor goes quiet), or the outgoing song having just dropped into it
 *   + how far the incoming song, alone after the switch, sits below the outgoing one
 *   + beat wobble in either window (a steady grid is what makes the beats lock)
 *   + a pair too far apart in tempo to match
 *   + a little for every second waited, and for every second of the incoming song skipped.
 * Null when either song has too few beats to mix on.
 */
export function chooseMixPoints(a: Features, b: Features, o: ChooseOptions): MixPoints | null {
  // Even a straight switch is judged on a couple of bars either side of it.
  const span = Math.max(8, o.plan.in + o.plan.out);
  const outSpan = o.loopBeats ?? span;
  const maxWait = o.maxWait ?? 40;
  if (a.beats.length < span + 8 || b.beats.length < span + 24) return null;
  const outTrim = o.outTrim ?? 0;
  const inTrim = o.inTrim ?? 0;
  const aUsual = songLoudness(a.loud) + outTrim;
  const bUsual = songLoudness(b.loud) + inTrim;
  const below = (usual: number, level: number) => Math.max(0, usual - level - 3) * 0.5;

  const phraseCandidates = (f: Features, anchor: number, ok: (i: number) => boolean) => {
    for (const step of [PHRASE, 4, 1]) {
      const out: number[] = [];
      for (let i = anchor % step; i < f.beats.length; i += step) if (ok(i)) out.push(i);
      if (out.length >= 2 || step === 1) return out;
    }
    return [];
  };
  const aAnchor = nearest(a.beats, a.mixOutS ?? a.duration - 8);
  const outs = phraseCandidates(a, aAnchor, (i) => {
    const t = a.beats[i] as number;
    return t >= o.from && t <= o.from + maxWait && i + outSpan + 2 < a.beats.length;
  });
  // Past every candidate (the song is nearly over): the last point that still fits.
  if (!outs.length) {
    const last = a.beats.length - outSpan - 3;
    if (last < 8) return null;
    outs.push(last);
  }
  const bAnchor = nearest(b.beats, b.mixInS ?? 0);
  const ins = phraseCandidates(
    b,
    bAnchor,
    (j) => (b.beats[j] as number) <= b.duration * 0.6 && j + span + 16 < b.beats.length,
  );

  const outGrid = new Map(
    outs.map((i) => [i, fitGrid(a.beats, Math.max(0, i - 8), i + outSpan, i)]),
  );
  const inGrid = new Map(ins.map((j) => [j, fitGrid(b.beats, j, j + span + 8, j)]));
  let best: MixPoints | null = null;
  for (const i of outs) {
    const ga = outGrid.get(i) as ReturnType<typeof fitGrid>;
    const la = mean(a.loud, i - 8, i + outSpan) + outTrim;
    const lead = mean(a.loud, i - 24, i - 8) + outTrim;
    for (const j of ins) {
      const gb = inGrid.get(j) as ReturnType<typeof fitGrid>;
      const lb = mean(b.loud, j, j + span) + inTrim;
      // The incoming song alone, right after the switch: it must hold the floor at once.
      const after = mean(b.loud, j + o.plan.in, j + o.plan.in + 16) + inTrim;
      // And the beats either side of the switch itself: a short breakdown there is a hole the
      // longer averages miss.
      const atSwitch = mean(b.loud, j + o.plan.in - 4, j + o.plan.in + 8) + inTrim;
      const matched = matchRate(ga.beat, 1, gb.beat) !== 1 || Math.abs(ga.beat - gb.beat) < 1e-4;
      const outS = ga.t;
      const inS = gb.t;
      const cost =
        Math.abs(la - lb) +
        below(aUsual, la) +
        below(bUsual, lb) +
        below(lead, la) +
        Math.max(0, la - after - 1.5) +
        Math.max(0, la - atSwitch - 1.5) +
        (ga.jitterMs + gb.jitterMs) / 5 +
        (matched ? 0 : 6) +
        0.04 * Math.max(0, outS - o.from) +
        0.02 * inS;
      if (!best || cost < best.cost)
        best = {
          outS,
          inS,
          outBeatS: ga.beat,
          inBeatS: gb.beat,
          waitS: Math.max(0, outS - o.from),
          outLoud: la,
          inLoud: lb,
          inAfterLoud: after,
          outJitterMs: ga.jitterMs,
          inJitterMs: gb.jitterMs,
          cost,
        };
    }
  }
  return best;
}

/**
 * Nudge a beat grid onto the song's own onsets, as a DJ nudges a grid by hand: the beat length
 * (within 2%) and the phase (within 60 ms of `t`) that put the most onset energy on `count`
 * beats. `env` is an onset-strength envelope at `hz` values per second.
 */
export function fitToOnsets(
  env: ArrayLike<number>,
  hz: number,
  t: number,
  beat: number,
  count: number,
): { t: number; beat: number } {
  const energy = (anchor: number, period: number) => {
    let s = 0;
    for (let k = 0; k < count; k++) {
      const x = (anchor + k * period) * hz;
      const i = Math.floor(x);
      if (i < 0 || i + 1 >= env.length) continue;
      const f = x - i;
      s += (env[i] as number) * (1 - f) + (env[i + 1] as number) * f;
    }
    return s;
  };
  let best = { e: energy(t, beat), t, beat };
  for (let p = -40; p <= 40; p++) {
    const period = beat * (1 + p / 2000);
    for (let d = -60; d <= 60; d += 5) {
      const e = energy(t + d / 1000, period);
      if (e > best.e) best = { e, t: t + d / 1000, beat: period };
    }
  }
  for (let d = -5; d <= 5; d++) {
    const e = energy(best.t + d / 1000, best.beat);
    if (e > best.e) best = { ...best, e, t: best.t + d / 1000 };
  }
  return { t: best.t, beat: best.beat };
}

/** What decides how a pair is switched. */
export type PairTraits = {
  /** The tempos are close enough to beat-match (matchRate). */
  matched: boolean;
  /** Camelot steps between the keys; null when either key is unknown. */
  keySteps: number | null;
  /** The incoming song's level just after the switch minus the outgoing one's (dB). */
  levelJumpDb: number;
};

/**
 * The switch for this pair: a blend with a bass swap whenever the tempos can be matched
 * (Rohit, 2026-10-23: of the four styles rendered on one pair, the blend "absolutely nailed
 * it" and the other three were not good, even though the keys clashed), and an echo out when
 * they can't. Filter and cut stay available when asked for by name.
 */
export function chooseStyle(t: PairTraits): Style {
  return t.matched ? "blend" : "echo";
}
