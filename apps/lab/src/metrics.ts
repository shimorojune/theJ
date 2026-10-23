/**
 * Objective checks on a rendered hand-over, measured on the audio as played rather than trusted
 * from the analysis (the same method as tools/mixlab): each deck's onsets against one shared
 * click grid, bar by bar, so the difference is how far apart the two songs' beats really land.
 * A DJ hears 20 ms or more as flamming.
 */

export const ENV_HZ = 100;

/** In-place radix-2 FFT of (re, im), length a power of two. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = (re[b] as number) * cr - (im[b] as number) * ci;
        const xi = (re[b] as number) * ci + (im[b] as number) * cr;
        re[b] = (re[a] as number) - xr;
        im[b] = (im[a] as number) - xi;
        re[a] = (re[a] as number) + xr;
        im[a] = (im[a] as number) + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Spectral flux of log magnitude, one value per 10 ms, local mean removed. */
export function onsetEnvelope(x: Float32Array[], sampleRate: number): Float64Array {
  const n = 2048;
  const hop = Math.round(sampleRate / ENV_HZ);
  const len = x[0]?.length ?? 0;
  const count = Math.floor(len / hop);
  const win = Float64Array.from(
    { length: n },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n),
  );
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let prev = new Float64Array(n / 2 + 1);
  let cur = new Float64Array(n / 2 + 1);
  const flux = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    const c = f * hop - n / 2;
    for (let i = 0; i < n; i++) {
      const at = c + i;
      let v = 0;
      if (at >= 0 && at < len) for (const ch of x) v += ch[at] as number;
      re[i] = (v / x.length) * (win[i] as number);
      im[i] = 0;
    }
    fft(re, im);
    let sum = 0;
    for (let k = 0; k <= n / 2; k++) {
      const m = Math.log1p(10 * Math.hypot(re[k] as number, im[k] as number));
      cur[k] = m;
      if (f > 0) sum += Math.max(0, m - (prev[k] as number));
    }
    flux[f] = sum;
    [prev, cur] = [cur, prev];
  }
  const out = new Float64Array(count);
  let acc = 0;
  for (let i = 0; i < count + 25; i++) {
    if (i < count) acc += flux[i] as number;
    if (i >= 50) acc -= flux[i - 50] as number;
    const centre = i - 25;
    if (centre >= 0 && centre < count)
      out[centre] = Math.max(0, (flux[centre] as number) - acc / 50);
  }
  return out;
}

/**
 * The shift (ms, within a quarter beat) that puts the most onset energy on the grid times.
 * A quarter beat, not half: intros full of off-beat hats would otherwise lock half a beat out.
 */
export function gridPhaseMs(env: Float64Array, grid: number[], beat: number): number {
  const span = Math.max(1, Math.floor((beat / 4) * ENV_HZ));
  let best = 0;
  let bestV = -1;
  for (let sh = -span; sh <= span; sh++) {
    let sum = 0;
    let k = 0;
    for (const t of grid) {
      const i = Math.round(t * ENV_HZ) + sh;
      if (i < 0 || i >= env.length) continue;
      sum += env[i] as number;
      k++;
    }
    const v = k ? sum / k : 0;
    if (v > bestV) {
      bestV = v;
      best = sh;
    }
  }
  return (best * 1000) / ENV_HZ;
}

/**
 * Lag (ms) of deck B's beats behind deck A's in each two-bar window from `from` to `to`
 * (context seconds), on A's grid. Positive: B is late.
 */
export function barLags(
  envA: Float64Array,
  envB: Float64Array,
  from: number,
  to: number,
  beat: number,
): number[] {
  const lags: number[] = [];
  for (let t = from; t + 4 * beat <= to + 1e-6; t += 4 * beat) {
    const grid = Array.from({ length: 8 }, (_, k) => t + k * beat).filter((g) => g <= to);
    // B is searched around where A's beats actually are, so a miss of up to a quarter beat
    // reads true instead of wrapping onto an off-beat.
    const shift = gridPhaseMs(envA, grid, beat) / 1000;
    lags.push(
      gridPhaseMs(
        envB,
        grid.map((g) => g + shift),
        beat,
      ),
    );
  }
  return lags;
}

export const median = (xs: number[]) => {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** Loudness (dB RMS) of the mix in one-second steps from `from` to `to`. */
export function loudness(
  x: Float32Array[],
  sampleRate: number,
  from: number,
  to: number,
): number[] {
  const out: number[] = [];
  for (let t = from; t + 1 <= to + 1e-6; t += 1) {
    const a = Math.floor(t * sampleRate);
    const b = Math.min(x[0]?.length ?? 0, Math.floor((t + 1) * sampleRate));
    let sum = 0;
    for (const ch of x) for (let i = a; i < b; i++) sum += (ch[i] as number) ** 2;
    out.push(10 * Math.log10(sum / Math.max(1, (b - a) * x.length) + 1e-12));
  }
  return out;
}

export function peakDb(x: Float32Array[]): number {
  let p = 0;
  for (const ch of x) for (const v of ch) p = Math.max(p, Math.abs(v));
  return 20 * Math.log10(p + 1e-12);
}
