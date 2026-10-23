/**
 * The DJ hand-over as data: when each deck, stem and the master move, in context seconds.
 * The phone (apps/mobile/src/party/mixerEngine.ts, react-native-audio-api) and the local lab
 * (apps/lab, Web Audio) both play these schedules, so a transition tuned in the lab is the one
 * the phone plays. Nothing here touches audio.
 */

/**
 * A planned mix: the next song comes up beat-matched under the current one with its bass cut
 * for IN beats; on the swap beat the current song is cut away (OUT 0), as a DJ switches,
 * rather than left fading over the new one.
 */
export const MIX = { in: 16, out: 0 };
/** A skip is the same move, just fast. */
export const SKIP = { in: 2, out: 2 };
/** "Mix it in now" and tapping Up next: a short DJ mix from the next bar. */
export const NOW = { in: 8, out: 4 };
export const MAX_TEMPO_STRETCH = 0.08;
/**
 * Two mastered songs summed can pass full scale. Rather than turning the master down while the
 * incoming song is still coming up (the floor goes quieter), the master runs through a soft
 * limiter: untouched below KNEE, rounded off above it (limiterCurve, for a WaveShaperNode).
 */
export const LIMITER_KNEE = 0.7;
export function limiterCurve(points = 4097): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points);
  const room = 1 - LIMITER_KNEE;
  for (let i = 0; i < points; i++) {
    // The shaper maps [-1, 1] onto the curve; inputs up to 2x full scale are rounded off.
    const x = ((i / (points - 1)) * 2 - 1) * 2;
    const a = Math.abs(x);
    const y = a <= LIMITER_KNEE ? a : LIMITER_KNEE + room * Math.tanh((a - LIMITER_KNEE) / room);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}
/** The shaper's input is scaled by this so inputs up to 2x full scale reach its curve. */
export const LIMITER_INPUT = 0.5;
/** The bass shelf each deck has: cut while a song is coming in, open once it owns the floor. */
export const BASS_HZ = 180;
export const BASS_CUT_DB = -18;
/** After a tempo-matched mix the new song eases back to its own tempo over this long (s). */
export const EASE_BACK_S = 20;

export type Plan = { in: number; out: number };

export type Style = "blend" | "filter" | "cut" | "echo";
/** The outgoing song leaves this long (s) before the incoming downbeat. */
export const SWITCH_S = 0.03;
/** Beats the filter style thins the outgoing song over before the switch. */
export const FILTER_BEATS = 8;
export const ECHO_FEEDBACK = 0.45;
/** The outgoing song's tail after a blend or cut: its lows (below the high-pass) go at once, the rest fades over the beats. */
export const TAIL_BEATS = 4;
export const TAIL_HIGHPASS_HZ = 250;
export const ECHO_TAIL_BEATS = 8;

/** What the planner needs to know about a song: its analysis. */
export type MixSong = {
  bpm?: number | null;
  mixInS?: number | null;
  mixOutS?: number | null;
  /** Beat length (s) at each mix point, fitted to the audio; absent on older analyses. */
  mixInBeatS?: number | null;
  mixOutBeatS?: number | null;
};

/**
 * One automation step: hold `v` from `t`, or reach `v` by `t` linearly (`ramp`) or
 * exponentially (`exp`, for frequencies; both values above 0).
 */
export type Step = { t: number; v: number; ramp?: true; exp?: true };
/** One param's moves: first drop whatever was scheduled from `cancel` on, then the steps. */
export type Schedule = { cancel?: number; steps: Step[] };

/** The slice of AudioParam both Web Audio and react-native-audio-api have. */
export interface ParamLike {
  cancelScheduledValues(t: number): unknown;
  setValueAtTime(v: number, t: number): unknown;
  linearRampToValueAtTime(v: number, t: number): unknown;
  exponentialRampToValueAtTime(v: number, t: number): unknown;
}

export function apply(param: ParamLike, s: Schedule | undefined) {
  if (!s) return;
  if (s.cancel != null) param.cancelScheduledValues(s.cancel);
  for (const { t, v, ramp, exp } of s.steps) {
    if (exp) param.exponentialRampToValueAtTime(v, t);
    else if (ramp) param.linearRampToValueAtTime(v, t);
    else param.setValueAtTime(v, t);
  }
}

/** Piecewise value of a schedule at `t`, starting from `initial` (for drawing and tests). */
export function valueAt(s: Schedule, t: number, initial = 0): number {
  let v = initial;
  let at = Number.NEGATIVE_INFINITY;
  for (const step of s.steps) {
    if (step.t <= t) {
      v = step.v;
      at = step.t;
      continue;
    }
    if (at === Number.NEGATIVE_INFINITY) return v;
    const u = (t - at) / (step.t - at);
    if (step.exp && v > 0 && step.v > 0) return v * (step.v / v) ** u;
    return step.ramp ? v + (step.v - v) * u : v;
  }
  return v;
}

/**
 * Beat length of `song` in its own time at a mix point: the grid the server fitted to the
 * audio there when it has one (song-wide bpm drifts 100 ms or more over a mix), else the bpm.
 */
export function songBeat(song: MixSong, at: "in" | "out"): number | null {
  const fitted = at === "in" ? song.mixInBeatS : song.mixOutBeatS;
  return fitted || (song.bpm ? 60 / song.bpm : null);
}

/**
 * Playback rate for the incoming song so one of its beats lasts as long as one beat of the
 * outgoing song as it plays now (half and double time allowed). 1 when they are too far apart.
 */
export function matchRate(outBeat: number, outRate: number, inBeat: number): number {
  const r = (inBeat * outRate) / outBeat;
  const best = [r, r / 2, r * 2].reduce((p, c) => (Math.abs(c - 1) < Math.abs(p - 1) ? c : p), r);
  return Math.abs(best - 1) <= MAX_TEMPO_STRETCH ? best : 1;
}

/** The first point at or after `earliest` on a grid of `period` through `anchor`. */
export function onGrid(anchor: number, period: number, earliest: number): number {
  return anchor + Math.ceil((earliest - anchor) / period - 1e-6) * period;
}

export type OutStem = "vocals" | "bass" | "rest";
export type InStem = "drums" | "other" | "rest";

/** The stems both songs have around this mix, for the stem hand-over. */
export type StemInput = {
  /** Context time now: the outgoing stems can't start before it. */
  now: number;
  /** Outgoing song position (s) and playback rate at context time `t`. */
  outPosAt(t: number): number;
  outRateAt(t: number): number;
  /** Where each stem window starts in its song (s), and each stem's length (s). */
  outStart: number;
  inStart: number;
  outLengths: Record<OutStem, number>;
  inLengths: Record<InStem, number>;
};

export type HandOverInput = {
  /** Context time the incoming song starts, on the outgoing song's beat grid. */
  when: number;
  plan: Plan;
  /** One beat in context seconds (the outgoing song's, as it plays now). */
  beat: number;
  /** Incoming playback rate (matchRate). */
  rate: number;
  /** Where the incoming song starts playing (s): its mix-in point. */
  inOffset: number;
  /** The master's value now, where its headroom dip starts. Null with no outgoing song. */
  master: number | null;
  /** Both songs' stems for this mix; null or missing for the classic hand-over. */
  stems?: StemInput | null;
  /** How to switch (chooseStyle); a blend by default. */
  style?: Style;
  /**
   * Loop the outgoing song from the mix point while the incoming one comes in, as a DJ sets up
   * a switch; with `roll` the loop halves over the last bar (2, 1, half a beat) into the swap.
   * Needs `outPos`, the outgoing song's position at `when` (s), and `outRate`, its rate there.
   */
  loop?: { beats: number; roll?: boolean } | null;
  outPos?: number;
  outRate?: number;
};

/**
 * One loop region of the outgoing song: from context time `at` (when its playhead is at
 * `startS`) it repeats [startS, startS + lengthS). Changes land on loop boundaries, so the
 * engine may set each a quarter beat after `at` (setAt) without a jump.
 */
export type LoopStep = { at: number; setAt: number; startS: number; lengthS: number };

export type StemVoices<K extends string> = {
  /** Context time the voices start, the stem offset they start at, and their rate. */
  at: number;
  offset: number;
  rate: number;
  stopAt: number;
  gain: Record<K, Schedule>;
};

export type HandOver = {
  when: number;
  /** The bass swap. */
  swap: number;
  /** The outgoing song is gone (and, with stems, the incoming full song has taken over). */
  end: number;
  beat: number;
  rate: number;
  inS: number;
  outS: number;
  style: Style;
  master?: Schedule;
  incoming: {
    offset: number;
    gain: Schedule;
    bass: Schedule;
    /** Low-pass cutoff (Hz) for the filter style; open (none) otherwise. */
    lowpass?: Schedule;
    /** The tempo easing back to the song's own once it owns the floor; null at rate 1. */
    easeBack: { at: number; dur: number; rate: Schedule } | null;
  };
  /** Present when there is an outgoing song. */
  outgoing?: {
    gain: Schedule;
    bass?: Schedule;
    stopAt: number;
    /** High-pass cutoff (Hz) for the filter style. */
    highpass?: Schedule;
    /**
     * Echo out: the outgoing deck feeds a delay of `delayS` with `feedback` through `send`; the
     * echo rings until `until`, after the deck itself has stopped.
     */
    echo?: { delayS: number; feedback: number; send: Schedule; until: number };
    /** Loop regions in order, and when the loop lets go (the song plays on from there). */
    loop?: { steps: LoopStep[]; releaseAt: number };
  };
  stems?: { out: StemVoices<OutStem>; in: StemVoices<InStem> };
};

/**
 * One switch from the outgoing song to the incoming one, in the style a DJ would pick for the
 * pair (chooseStyle):
 *   blend   the incoming song comes up under the outgoing one over `plan.in` beats, bass cut,
 *           and takes over on the swap beat (with stems for both songs, stem by stem instead)
 *   filter  the outgoing song thins out through a rising high-pass over FILTER_BEATS beats; the
 *           incoming one drops in on the one with its highs opening over a bar
 *   cut     a straight switch on the one
 *   echo    the outgoing song's last beat echoes out under the incoming one, which drops in on
 *           the one at its own tempo
 * In every style the outgoing song leaves just before the incoming downbeat, never on it.
 */
export function planHandOver(i: HandOverInput): HandOver {
  const { when, beat } = i;
  const style = i.style ?? "blend";
  // Echo out drops the new song on the one at its own tempo: no stretching to match.
  const rate = style === "echo" ? 1 : i.rate;
  // Only a blend runs the new song under the old one; the others switch at `when`.
  const inS = style === "blend" ? Math.min(14, i.plan.in * beat) : 0;
  const outS = Math.min(8, i.plan.out * beat);
  const swap = when + inS;
  // With stems the outgoing drums and music trail off over the tail too, never at once.
  const stemOut = outS > 0 ? outS : TAIL_BEATS * beat;
  const stems =
    style === "blend" && i.master != null && i.stems
      ? stemHandOver(i.stems, when, rate, i.inOffset, inS, stemOut, beat)
      : null;
  // Blend and cut leave with a tail: on the switch the outgoing lows go (no second kick under
  // the new downbeat), and the rest of it fades over TAIL_BEATS, so it never just stops.
  const tailS =
    !stems && outS === 0 && (style === "blend" || style === "cut") ? TAIL_BEATS * beat : 0;
  const end = stems ? swap + stemOut + beat : swap + outS + tailS;
  // A clean switch: the old song is gone just before the new song's downbeat, so the two
  // downbeats never land together (a flam, or a doubled beat).
  const cutAt = Math.max(when, swap - SWITCH_S);

  const h: HandOver = {
    when,
    swap,
    end,
    beat,
    rate,
    inS,
    outS,
    style,
    incoming: {
      offset: i.inOffset,
      gain: { steps: [{ t: when, v: 1 }] },
      bass: { steps: [] },
      easeBack: null,
    },
  };
  if (stems) {
    // The stems carry the hand-over; the full song takes over from them as it ends.
    h.incoming.gain = {
      steps: [
        { t: when, v: 0 },
        { t: end - beat, v: 0 },
        { t: end, v: 1, ramp: true },
      ],
    };
  } else if (style === "blend" && inS > 0) {
    // Up under the old song, bass cut, at full level by the switch.
    h.incoming.gain = {
      steps: [
        { t: when, v: 0 },
        { t: cutAt, v: 1, ramp: true },
      ],
    };
    h.incoming.bass = {
      steps: [
        { t: when, v: BASS_CUT_DB },
        { t: cutAt, v: BASS_CUT_DB },
        { t: swap, v: 0, ramp: true },
      ],
    };
  } else if (style === "filter") {
    // In on the one with its highs closed, opening over a bar.
    h.incoming.lowpass = {
      steps: [
        { t: swap, v: 300 },
        { t: swap + 4 * beat, v: 20000, exp: true },
      ],
    };
  }
  if (rate !== 1)
    h.incoming.easeBack = {
      at: end,
      dur: EASE_BACK_S,
      rate: {
        steps: [
          { t: end, v: rate },
          { t: end + EASE_BACK_S, v: 1, ramp: true },
        ],
      },
    };
  if (i.master == null) return h;

  // No dip: neither song gets quieter before the other has come up to its level (the limiter
  // catches the peaks). A master left low by anything else is brought back over a beat.
  h.master = {
    cancel: when,
    steps: [
      { t: when, v: i.master },
      { t: when + beat, v: 1, ramp: true },
    ],
  };
  if (stems) {
    h.outgoing = {
      // Outgoing: full audio hands to its stems over [from, when].
      gain: {
        cancel: stems.out.at,
        steps: [
          { t: stems.out.at, v: 1 },
          { t: when, v: 0, ramp: true },
        ],
      },
      stopAt: end + 0.1,
    };
    h.stems = stems;
    return h;
  }
  const lead = style === "filter" ? FILTER_BEATS * beat : 0;
  h.outgoing = {
    // Out at the switch; with `plan.out` beats it fades over them instead (a longer blend).
    gain:
      outS > 0
        ? {
            cancel: when - lead,
            steps: [
              { t: swap, v: 1 },
              { t: end, v: 0, ramp: true },
            ],
          }
        : tailS > 0
          ? {
              cancel: when - lead,
              steps: [
                { t: swap, v: 1 },
                { t: swap + tailS / 4, v: 0.8, ramp: true },
                { t: swap + tailS / 2, v: 0.45, ramp: true },
                { t: end, v: 0, ramp: true },
              ],
            }
          : {
              cancel: when - lead,
              steps: [
                { t: cutAt, v: 1 },
                { t: swap, v: 0, ramp: true },
              ],
            },
    stopAt: end + 0.1,
  };
  if (outS > 0)
    h.outgoing.bass = {
      steps: [
        { t: swap, v: 0 },
        { t: swap + beat, v: BASS_CUT_DB, ramp: true },
      ],
    };
  if (tailS > 0)
    h.outgoing.highpass = {
      steps: [
        // The lows ease out over the first beat rather than dropping at once.
        { t: cutAt, v: 20 },
        { t: swap + beat, v: TAIL_HIGHPASS_HZ, exp: true },
      ],
    };
  if (style === "filter")
    // The old song thins out from the bottom over the bars before the switch.
    h.outgoing.highpass = {
      steps: [
        { t: swap - lead, v: 20 },
        { t: cutAt, v: 1200, exp: true },
      ],
    };
  if (style === "echo")
    // Its last beat goes into a beat-long echo that rings out under the new song.
    h.outgoing.echo = {
      delayS: beat,
      feedback: ECHO_FEEDBACK,
      send: {
        steps: [
          { t: swap - beat, v: 0 },
          { t: swap - beat + 0.01, v: 1, ramp: true },
        ],
      },
      until: swap + ECHO_TAIL_BEATS * beat,
    };
  if (style === "blend" && i.loop && i.outPos != null && i.plan.in >= 8)
    h.outgoing.loop = planLoop(i.loop, i.outPos, i.outRate ?? 1, when, swap, beat);
  return h;
}

/**
 * The outgoing loop: `beats` long from the mix point; with `roll`, from the last bar before the
 * swap it loops the beat it is on for 2 beats, then 1, then half, and lets go just after the
 * swap, so the outgoing song plays on (fading) from there.
 */
function planLoop(
  loop: { beats: number; roll?: boolean },
  outPos: number,
  outRate: number,
  when: number,
  swap: number,
  beat: number,
): { steps: LoopStep[]; releaseAt: number } {
  const songBeat = beat * outRate;
  const steps: LoopStep[] = [
    { at: when, setAt: when - 0.3, startS: outPos, lengthS: loop.beats * songBeat },
  ];
  if (loop.roll) {
    // Where the loop's playhead is 4 beats before the swap: a whole number of beats in.
    const into = Math.round((swap - 4 * beat - when) / beat) % loop.beats;
    const startS = outPos + into * songBeat;
    for (const [before, len] of [
      [4, 2],
      [2, 1],
      [1, 0.5],
    ] as const) {
      const at = swap - before * beat;
      steps.push({ at, setAt: at + beat / 4, startS, lengthS: len * songBeat });
    }
  }
  // A quarter beat in: mid-loop for every length, so letting go never catches a wrap.
  return { steps, releaseAt: swap + beat / 4 };
}

/**
 * The DJ hand-over with stems, bars counted from `when` (inS = 16 beats in, outS = 8 out at
 * the usual plan)
 *   one beat before   the outgoing song crossfades from its full audio to its stems (they
 *                     sum to the same sound, so nothing audible changes)
 *   first half        the incoming drums ride in under it
 *   second half       the incoming music comes up; the outgoing vocals leave over the beat
 *                     before the swap, once it is up
 *   swap              bass swap on the downbeat: outgoing bass out, incoming bass and vocals in
 *   out               the outgoing drums and music fade; then the incoming full song takes over
 *                     from its stems over a beat
 * Null when either song's stems don't cover the mix, so the caller does the classic hand-over.
 */
function stemHandOver(
  s: StemInput,
  when: number,
  rate: number,
  inOffset: number,
  inS: number,
  outS: number,
  beat: number,
): { out: StemVoices<OutStem>; in: StemVoices<InStem> } | null {
  const swap = when + inS;
  const end = swap + outS;
  const from = Math.max(when - beat, s.now + 0.03);
  const outRate = s.outRateAt(from);
  const offA = s.outPosAt(from) - s.outStart;
  const offB = inOffset - s.inStart;
  const needA = (end - from) * outRate;
  const needB = (end + beat - when) * rate;
  const cover = (lengths: Record<string, number>, off: number, need: number) =>
    off >= 0 && Object.values(lengths).every((len) => off + need <= len);
  if (!cover(s.outLengths, offA, needA) || !cover(s.inLengths, offB, needB)) return null;

  const env = (points: [number, number][]): Schedule => ({
    steps: points.map(([t, v], k) => (k === 0 ? { t, v } : { t, v, ramp: true })),
  });
  const mid = when + inS / 2;
  const cut = 0.02;
  return {
    out: {
      at: from,
      offset: offA,
      rate: outRate,
      stopAt: end + 0.1,
      gain: {
        // Out over the last beat before the swap, once the incoming music is up to level.
        vocals: env([
          [from, 0],
          [when, 1],
          [swap - beat, 1],
          [swap, 0],
        ]),
        bass: env([
          [from, 0],
          [when, 1],
          [swap, 1],
          [swap + cut, 0],
        ]),
        rest: env([
          [from, 0],
          [when, 1],
          [swap, 1],
          [end, 0],
        ]),
      },
    },
    // Incoming: drums, then music, then bass and vocals on the swap; full audio after.
    in: {
      at: when,
      offset: offB,
      rate,
      stopAt: end + beat + 0.1,
      gain: {
        drums: env([
          [when, 0],
          [mid, 1],
          [end, 1],
          [end + beat, 0],
        ]),
        other: env([
          [when, 0],
          [mid, 0],
          [swap - beat, 1],
          [end, 1],
          [end + beat, 0],
        ]),
        rest: env([
          [when, 0],
          [swap, 0],
          [swap + cut, 1],
          [end, 1],
          [end + beat, 0],
        ]),
      },
    },
  };
}
