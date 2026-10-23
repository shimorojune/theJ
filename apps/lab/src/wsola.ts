/**
 * The phone's pitch-corrected playback, offline: a line-by-line port of react-native-audio-api's
 * WsolaTimeStretcher (common/cpp/audioapi/dsp/WsolaTimeStretcher.cpp, 0.13.6) driven the way
 * AudioBufferBaseSourceNode drives it, one 128-frame render quantum at a time. Every deck on the
 * phone plays through it (pitchCorrection: true), even at rate 1, so it sets both the stretch
 * artefacts and the start latency (~50 ms) of each deck; the lab hears both.
 *
 * Differences from the C++: indices are absolute (no queue compaction, which only renumbers),
 * and the deck's own buffer is the input queue (the source node copies it in quantum by quantum).
 */

const QUANTUM = 128;
const OLA_WINDOW_MS = 20;
const SEARCH_INTERVAL_MS = 30;
const SEARCH_DECIMATION = 12;

const framesFromMs = (sr: number, ms: number) => Math.max(1, Math.round((sr * ms) / 1000));
const periodicHann = (n: number, size: number) => 0.5 * (1 - Math.cos((2 * Math.PI * n) / size));

/**
 * Play `src` from frame `start` for `frames` output frames through the stretcher, the playback
 * rate read once per quantum from `rateAt(outputFrame)` (k-rate, as on the phone).
 */
export function stretchDeck(
  src: Float32Array[],
  start: number,
  frames: number,
  sampleRate: number,
  rateAt: (frame: number) => number,
  /** Pitch shift (cents) per quantum, as the source's detune param: the stretcher resamples. */
  detuneAt?: (frame: number) => number,
): Float32Array[] & { latency: number } {
  const channels = src.length;
  let windowSize = framesFromMs(sampleRate, OLA_WINDOW_MS);
  windowSize += windowSize & 1;
  const hop = windowSize / 2;
  const searchInterval = framesFromMs(sampleRate, SEARCH_INTERVAL_MS);
  const searchCenterOffset = Math.floor(searchInterval / 2) + (windowSize / 2 - 1);
  const excludeInterval = framesFromMs(sampleRate, 3.3);
  const searchBlockSize = searchInterval + windowSize - 1;
  const ola = Float32Array.from({ length: windowSize }, (_, i) => periodicHann(i, windowSize));
  const trans = Float32Array.from({ length: windowSize * 2 }, (_, i) =>
    periodicHann(i, windowSize * 2),
  );

  // The input queue: src from `start`, of which `fed` frames have been handed over so far.
  const input = src.map((c) => c.subarray(Math.min(start, c.length)));
  let fed = 0;
  const out = src.map(() => new Float32Array(frames));
  // Produced output not yet read, as a growing queue per channel.
  const queue = src.map(() => new Float32Array(frames + hop * 4 + QUANTUM * 4));
  let produced = 0;
  let read = 0;
  // Output frame the first produced frame (input frame 0, faded in) is written to.
  let latency = -1;
  const pending = src.map(() => new Float32Array(hop));
  const target = src.map(() => new Float32Array(windowSize));
  const optimal = src.map(() => new Float32Array(windowSize));
  const span = src.map(() => new Float32Array(searchInterval + windowSize));
  const targetEnergy = new Float64Array(channels);

  let synthesisPosition = 0;
  let pitch = 1;
  let targetBlockIndex = 0;
  let searchBlockIndex = 0;

  const sampleAt = (ch: number, i: number): number => {
    const q = input[ch] as Float32Array;
    const size = Math.min(fed, q.length);
    if (i < 0 || size === 0) return 0;
    const x = i * pitch;
    if (x >= size - 1) return q[size - 1] as number;
    const i0 = Math.floor(x);
    const f = x - i0;
    return f === 0 ? (q[i0] as number) : (q[i0] as number) * (1 - f) + (q[i0 + 1] as number) * f;
  };
  const fillBlock = (block: Float32Array[], at: number) => {
    for (let ch = 0; ch < channels; ch++) {
      const b = block[ch] as Float32Array;
      for (let f = 0; f < windowSize; f++) b[f] = sampleAt(ch, at + f);
    }
  };
  const maxSourceIndexForBlock = (b: number) => Math.ceil((b + windowSize - 1) * pitch);
  const inputFrames = () => Math.min(fed, input[0]?.length ?? 0);
  const canRun = () =>
    maxSourceIndexForBlock(targetBlockIndex) < inputFrames() &&
    maxSourceIndexForBlock(searchBlockIndex + searchBlockSize - 1) < inputFrames();
  const withinSearch = () =>
    targetBlockIndex >= searchBlockIndex &&
    targetBlockIndex + windowSize <= searchBlockIndex + searchBlockSize;

  const similarityAt = (candidate: number): number => {
    const off = candidate - searchBlockIndex;
    let score = 0;
    for (let ch = 0; ch < channels; ch++) {
      const t = target[ch] as Float32Array;
      const s = span[ch] as Float32Array;
      let dot = 0;
      let energy = 0;
      for (let f = 0; f < windowSize; f++) {
        const c = s[off + f] as number;
        dot += (t[f] as number) * c;
        energy += c * c;
      }
      score += dot / Math.sqrt((targetEnergy[ch] as number) * energy + 1e-12);
    }
    return score;
  };

  const findOptimal = (): number => {
    fillBlock(target, targetBlockIndex);
    for (let ch = 0; ch < channels; ch++) {
      let e = 0;
      for (const v of target[ch] as Float32Array) e += v * v;
      targetEnergy[ch] = e;
      const s = span[ch] as Float32Array;
      for (let j = 0; j < s.length; j++) s[j] = sampleAt(ch, searchBlockIndex + j);
    }
    if (searchInterval <= 1) return searchBlockIndex;
    const previous = targetBlockIndex - hop;
    const half = Math.floor(excludeInterval / 2);
    const excluded = (i: number) => i >= previous - half && i <= previous + half;
    let best = Number.NEGATIVE_INFINITY;
    let bestIndex = searchBlockIndex;
    for (let off = 0; off < searchInterval; off += SEARCH_DECIMATION) {
      const i = searchBlockIndex + off;
      if (excluded(i)) continue;
      const s = similarityAt(i);
      if (s > best) {
        best = s;
        bestIndex = i;
      }
    }
    const lo = Math.max(searchBlockIndex, bestIndex - SEARCH_DECIMATION);
    const hi = Math.min(searchBlockIndex + searchInterval - 1, bestIndex + SEARCH_DECIMATION);
    for (let i = lo; i <= hi; i++) {
      if (excluded(i)) continue;
      const s = similarityAt(i);
      if (s > best) {
        best = s;
        bestIndex = i;
      }
    }
    return bestIndex;
  };

  const runOne = (rate: number): boolean => {
    if (!canRun()) return false;
    const transition = !withinSearch();
    const index = transition ? findOptimal() : targetBlockIndex;
    fillBlock(optimal, index);
    if (transition) {
      fillBlock(target, targetBlockIndex);
      for (let ch = 0; ch < channels; ch++) {
        const o = optimal[ch] as Float32Array;
        const t = target[ch] as Float32Array;
        for (let f = 0; f < windowSize; f++)
          o[f] =
            (o[f] as number) * (trans[f] as number) +
            (t[f] as number) * (trans[windowSize + f] as number);
      }
    }
    for (let ch = 0; ch < channels; ch++) {
      const q = queue[ch] as Float32Array;
      const o = optimal[ch] as Float32Array;
      const p = pending[ch] as Float32Array;
      for (let f = 0; f < hop; f++) {
        if (produced + f < q.length)
          q[produced + f] =
            (p[f] as number) * (ola[hop + f] as number) + (o[f] as number) * (ola[f] as number);
        p[f] = o[hop + f] as number;
      }
    }
    produced += hop;
    targetBlockIndex = index + hop;
    synthesisPosition += (hop * rate) / pitch;
    searchBlockIndex = Math.floor(synthesisPosition + 0.5) - searchCenterOffset;
    return true;
  };

  const write = (offset: number, n: number): number => {
    const k = Math.min(n, produced - read, frames - offset);
    if (k <= 0) return 0;
    if (latency < 0) latency = offset - read;
    for (let ch = 0; ch < channels; ch++)
      (out[ch] as Float32Array).set((queue[ch] as Float32Array).subarray(read, read + k), offset);
    read += k;
    return k;
  };

  for (let q = 0; q < frames; q += QUANTUM) {
    const n = Math.min(QUANTUM, frames - q);
    const rate = Math.min(4, Math.max(0, rateAt(q)));
    pitch = detuneAt ? 2 ** (detuneAt(q) / 1200) : 1;
    if (rate <= 0) continue;
    fed += Math.max(1, Math.ceil(rate * n));
    let rendered = 0;
    while (rendered < n) {
      rendered += write(q + rendered, n - rendered);
      if (rendered >= n || !runOne(rate)) break;
    }
    if (rate < 1 && rendered >= n && produced - read < n * 2) runOne(rate);
  }
  return Object.assign(out, { latency: Math.max(0, latency) });
}
