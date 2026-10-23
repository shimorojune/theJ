/**
 * The DJ hand-over as data: when each deck, stem and the master move, in context seconds.
 * The phone (apps/mobile/src/party/mixerEngine.ts, react-native-audio-api) and the local lab
 * (apps/lab, Web Audio) both play these schedules, so a transition tuned in the lab is the one
 * the phone plays. Nothing here touches audio.
 */

/**
 * A planned mix: the next song runs beat-matched under the current one with its bass cut for
 * IN beats, the bass swaps on a beat, and the current song drops out over OUT beats.
 */
export const MIX = { in: 16, out: 8 };
/** A skip is the same move, just fast. */
export const SKIP = { in: 2, out: 2 };
/** "Mix it in now" and tapping Up next: a short DJ mix from the next bar. */
export const NOW = { in: 8, out: 4 };
export const MAX_TEMPO_STRETCH = 0.08;
/** Two mastered songs summed clip; the master dips this far (-3 dB) while both play. */
export const MIX_HEADROOM = 0.71;
/** The bass shelf each deck has: cut while a song is coming in, open once it owns the floor. */
export const BASS_HZ = 180;
export const BASS_CUT_DB = -18;
/** After a tempo-matched mix the new song eases back to its own tempo over this long (s). */
export const EASE_BACK_S = 20;

export type Plan = { in: number; out: number };

/** What the planner needs to know about a song: its analysis. */
export type MixSong = {
  bpm?: number | null;
  mixInS?: number | null;
  mixOutS?: number | null;
  /** Beat length (s) at each mix point, fitted to the audio; absent on older analyses. */
  mixInBeatS?: number | null;
  mixOutBeatS?: number | null;
};

/** One automation step: hold `v` from `t`, or (with `ramp`) reach `v` linearly by `t`. */
export type Step = { t: number; v: number; ramp?: true };
/** One param's moves: first drop whatever was scheduled from `cancel` on, then the steps. */
export type Schedule = { cancel?: number; steps: Step[] };

/** The slice of AudioParam both Web Audio and react-native-audio-api have. */
export interface ParamLike {
  cancelScheduledValues(t: number): unknown;
  setValueAtTime(v: number, t: number): unknown;
  linearRampToValueAtTime(v: number, t: number): unknown;
}

export function apply(param: ParamLike, s: Schedule | undefined) {
  if (!s) return;
  if (s.cancel != null) param.cancelScheduledValues(s.cancel);
  for (const { t, v, ramp } of s.steps) {
    if (ramp) param.linearRampToValueAtTime(v, t);
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
    return step.ramp && at > Number.NEGATIVE_INFINITY
      ? v + ((step.v - v) * (t - at)) / (step.t - at)
      : v;
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
};

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
  master?: Schedule;
  incoming: {
    offset: number;
    gain: Schedule;
    bass: Schedule;
    /** The tempo easing back to the song's own once it owns the floor; null at rate 1. */
    easeBack: { at: number; dur: number; rate: Schedule } | null;
  };
  /** Present when there is an outgoing song. */
  outgoing?: { gain: Schedule; bass?: Schedule; stopAt: number };
  stems?: { out: StemVoices<OutStem>; in: StemVoices<InStem> };
};

/**
 * Bring the incoming song in at `when`, tempo-matched, bass cut. After `plan.in` beats the bass
 * swaps and the outgoing song drops out over `plan.out` beats. With stems for both songs the
 * hand-over is done stem by stem instead (stemHandOver).
 */
export function planHandOver(i: HandOverInput): HandOver {
  const { when, beat, rate } = i;
  const inS = Math.min(14, i.plan.in * beat);
  const outS = Math.min(8, i.plan.out * beat);
  const swap = when + inS;
  const stems =
    i.master != null && i.stems
      ? stemHandOver(i.stems, when, rate, i.inOffset, inS, outS, beat)
      : null;
  const end = swap + outS + (stems ? beat : 0);

  const h: HandOver = {
    when,
    swap,
    end,
    beat,
    rate,
    inS,
    outS,
    incoming: stems
      ? {
          offset: i.inOffset,
          // The stems carry the hand-over; the full song takes over from them as it ends.
          gain: {
            steps: [
              { t: when, v: 0 },
              { t: end - beat, v: 0 },
              { t: end, v: 1, ramp: true },
            ],
          },
          bass: { steps: [] },
          easeBack: null,
        }
      : {
          offset: i.inOffset,
          gain: {
            steps: [
              { t: when, v: 0 },
              { t: swap, v: 1, ramp: true },
            ],
          },
          bass: {
            steps: [
              { t: when, v: BASS_CUT_DB },
              { t: swap + beat, v: 0, ramp: true },
            ],
          },
          easeBack: null,
        },
  };
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

  // Headroom while both decks play, eased so the dip itself is not heard.
  h.master = {
    cancel: when,
    steps: [
      { t: when, v: i.master },
      { t: when + 2 * beat, v: MIX_HEADROOM, ramp: true },
      { t: end, v: MIX_HEADROOM },
      { t: end + 4 * beat, v: 1, ramp: true },
    ],
  };
  h.outgoing = stems
    ? {
        // Outgoing: full audio hands to its stems over [from, when].
        gain: {
          cancel: stems.out.at,
          steps: [
            { t: stems.out.at, v: 1 },
            { t: when, v: 0, ramp: true },
          ],
        },
        stopAt: end + 0.1,
      }
    : {
        gain: {
          cancel: when,
          steps: [
            { t: swap, v: 1 },
            { t: end, v: 0, ramp: true },
          ],
        },
        bass: {
          steps: [
            { t: swap, v: 0 },
            { t: swap + beat, v: BASS_CUT_DB, ramp: true },
          ],
        },
        stopAt: end + 0.1,
      };
  if (stems) h.stems = stems;
  return h;
}

/**
 * The DJ hand-over with stems, bars counted from `when` (inS = 16 beats in, outS = 8 out at
 * the usual plan)
 *   one beat before   the outgoing song crossfades from its full audio to its stems (they
 *                     sum to the same sound, so nothing audible changes)
 *   first half        the incoming drums ride in under it
 *   second half       the outgoing vocals fade out; the incoming music comes in
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
        vocals: env([
          [from, 0],
          [when, 1],
          [mid, 1],
          [when + inS * 0.875, 0],
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
          [swap, 1],
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
