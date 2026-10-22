"""Mix lab: render song-to-song hand-overs the way the phone plays them, and score them.

    python tools/mixlab/mixlab.py fetch            # pulled songs + analysis from the api
    python tools/mixlab/mixlab.py render A B       # one mix to out/A__B.wav, plus its score
    python tools/mixlab/mixlab.py bench [--n 40]   # score many pairs, write out/bench.md

The render mirrors apps/mobile/src/party/mixerEngine.ts (MIX plan): B starts at its mix-in
beat exactly on A's mix-out beat, sped up or slowed to A's tempo with the key held, bass cut;
after 16 beats the bass swaps and A drops out over 8.

Scoring listens to the result instead of trusting the analysis: onset envelopes of the two
decks as played are cross-correlated in short windows across the overlap. The lag of the best
match is how far apart the beats really land (0 ms is perfect; a DJ hears 20 ms or more as
flamming). Drift is the change in lag from the first window to the last.

Env: THEJ_API (default https://thej.rraj.dev), THEJ_DEV_USER, THEJ_DEV_TOKEN.
Needs numpy and av (tools/mixlab/requirements.txt); the DSP is ffmpeg's, through av.
"""

import argparse
from fractions import Fraction
import json
import os
import random
import sys
import urllib.request
from pathlib import Path

import av
import numpy as np

HERE = Path(__file__).parent
CACHE = HERE / ".cache"
OUT = HERE / "out"
SR = 44100

# The phone's MIX plan and limits (keep in step with mixerEngine.ts).
MIX_IN_BEATS, MIX_OUT_BEATS = 16, 8
MAX_STRETCH = 0.08
BASS_HZ, BASS_CUT_DB = 180.0, -18.0


# --- data --------------------------------------------------------------------------------


def api_get(path):
    base = os.environ.get("THEJ_API", "https://thej.rraj.dev")
    req = urllib.request.Request(base + path)
    req.add_header("x-dev-user", os.environ.get("THEJ_DEV_USER", "lab"))
    req.add_header("x-dev-token", os.environ["THEJ_DEV_TOKEN"])
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def fetch(limit):
    CACHE.mkdir(exist_ok=True)
    songs = api_get(f"/lab/songs?limit={limit}")
    for s in songs:
        dest = CACHE / f"{safe(s['songId'])}.m4a"
        if not dest.exists():
            urllib.request.urlretrieve(s["audioUrl"], dest)
    (CACHE / "songs.json").write_text(json.dumps(songs, indent=1))
    print(f"{len(songs)} songs in {CACHE}")


def safe(song_id):
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in song_id)


def library():
    songs = json.loads((CACHE / "songs.json").read_text())
    return {s["songId"]: s for s in songs if s.get("bpm") and s.get("beats")}


def load(song):
    """Stereo float32 at SR."""
    c = av.open(str(CACHE / f"{safe(song['songId'])}.m4a"))
    r = av.AudioResampler(format="fltp", layout="stereo", rate=SR)
    parts = []
    for frame in c.decode(c.streams.audio[0]):
        parts.extend(f.to_ndarray() for f in r.resample(frame))
    parts.extend(f.to_ndarray() for f in r.resample(None))
    return np.concatenate(parts, axis=1).astype(np.float32)


# --- dsp ---------------------------------------------------------------------------------


def ffmpeg(x, name, args):
    """Run stereo float audio through one ffmpeg filter."""
    g = av.filter.Graph()
    src = g.add_abuffer(format="fltp", sample_rate=SR, layout="stereo", time_base=f"1/{SR}")
    f = g.add(name, args)
    fmt = g.add("aformat", "sample_fmts=fltp:channel_layouts=stereo")
    sink = g.add("abuffersink")
    src.link_to(f)
    f.link_to(fmt)
    fmt.link_to(sink)
    g.configure()
    out = []

    def drain():
        while True:
            try:
                out.append(sink.pull().to_ndarray())
            except (av.BlockingIOError, av.EOFError):
                return

    for i in range(0, x.shape[1], SR):
        frame = av.AudioFrame.from_ndarray(
            np.ascontiguousarray(x[:, i : i + SR]), format="fltp", layout="stereo"
        )
        frame.sample_rate = SR
        frame.pts = i
        frame.time_base = Fraction(1, SR)
        src.push(frame)
        drain()
    src.push(None)
    drain()
    return np.concatenate(out, axis=1).astype(np.float32)


# atempo's output runs about 20 ms early (measured on a click train, constant, no drift).
ATEMPO_LEAD = int(0.020 * SR)


def stretch(x, rate):
    """Play `x` `rate` times faster with the pitch held, timing-corrected (ffmpeg atempo)."""
    if abs(rate - 1) < 1e-4:
        return x
    return np.pad(ffmpeg(x, "atempo", f"{rate:.6f}"), ((0, 0), (ATEMPO_LEAD, 0)))


def low_shelf(x, db):
    """Low shelf at BASS_HZ, slope 1 (the phone's BiquadFilterNode 'lowshelf')."""
    y = ffmpeg(x, "lowshelf", f"g={db}:f={BASS_HZ}:t=s:w=1")
    return y[:, : x.shape[1]] if y.shape[1] >= x.shape[1] else np.pad(y, ((0, 0), (0, x.shape[1] - y.shape[1])))


def ramp(n, points):
    """Piecewise-linear envelope over n samples from [(t_seconds, value), ...]."""
    t = np.arange(n) / SR
    xs, ys = zip(*points)
    return np.interp(t, xs, ys).astype(np.float32)


def onset_env(x):
    """Spectral flux (log magnitude), 10 ms hop, as a float array."""
    mono = x.mean(axis=0)
    hop, n = 441, 2048
    frames = np.lib.stride_tricks.sliding_window_view(np.pad(mono, (n // 2, n // 2)), n)[::hop]
    mag = np.log1p(10 * np.abs(np.fft.rfft(frames * np.hanning(n), axis=1)))
    flux = np.maximum(np.diff(mag, axis=0), 0).sum(axis=1)
    flux = flux - np.convolve(flux, np.ones(50) / 50, mode="same")
    return np.maximum(flux, 0)


def grid_phase_ms(env, grid_s, beat_s):
    """Shift (ms, within a quarter beat) that puts the most onset energy on the grid times.

    A quarter beat, not half: intros full of off-beat hats would otherwise lock half a beat out
    and read as a 250 ms miss while the grid is right (later bars of the same song confirm it).
    """
    span = max(1, int(beat_s / 4 * 100))
    idx = np.round(np.asarray(grid_s) * 100).astype(int)
    best, best_v = 0, -1.0
    for sh in range(-span, span + 1):
        i = idx + sh
        i = i[(i >= 0) & (i < len(env))]
        v = float(env[i].mean()) if len(i) else 0.0
        if v > best_v:
            best, best_v = sh, v
    return best * 10


def lag_ms(ea, eb, beat_s):
    """Best lag (ms) of eb against ea within half a beat, and the match strength."""
    span = max(1, int(beat_s / 2 * 100))
    best, best_c = 0, -1.0
    for lag in range(-span, span + 1):
        a = ea[max(0, lag) : len(ea) + min(0, lag)]
        b = eb[max(0, -lag) : len(eb) + min(0, -lag)]
        m = min(len(a), len(b))
        if m < 50:
            continue
        c = float(np.dot(a[:m], b[:m]) / (np.linalg.norm(a[:m]) * np.linalg.norm(b[:m]) + 1e-9))
        if c > best_c:
            best, best_c = lag, c
    return best * 10, best_c


# --- the mix -----------------------------------------------------------------------------


# GRID = "global": the song-wide bpm from its first mix beat (the phone today).
# GRID = "local": a straight line fitted through the analysed beats of the mix window.
# GRID = "fitted": a grid fitted to the song's own onsets over the mix window.
# GRID = "server": the analyser's fitted grid as served to the phone (mixInBeatS/mixOutBeatS).
GRID = "fitted"
WINDOW_BEATS = MIX_IN_BEATS + MIX_OUT_BEATS


_ENV = {}


def song_env(song):
    if song["songId"] not in _ENV:
        _ENV[song["songId"]] = onset_env(load(song))
    return _ENV[song["songId"]]


def fitted_grid(song, t0):
    """Beat grid fitted to the song's own onsets over the mix window: the period (within 2% of
    the analysed bpm) and the phase (within 60 ms of t0) that put the most onset energy on the
    beats, like nudging a grid by hand in DJ software. Phase refined to 1 ms."""
    env = song_env(song)
    base = 60 / song["bpm"]
    k = np.arange(WINDOW_BEATS)
    t = np.arange(len(env)) / 100

    def energy(anchor, period):
        return float(np.interp(anchor + k * period, t, env).mean())

    best = (energy(t0, base), t0, base)
    for period in base * (1 + np.linspace(-0.02, 0.02, 81)):
        for anchor in t0 + np.arange(-0.06, 0.0605, 0.005):
            e = energy(anchor, period)
            if e > best[0]:
                best = (e, anchor, period)
    _, anchor, period = best
    for anchor2 in anchor + np.arange(-0.005, 0.0051, 0.001):
        e = energy(anchor2, period)
        if e > best[0]:
            best = (e, anchor2, period)
    return float(best[1]), float(best[2])


def local_grid(song, t0):
    """(anchor, period): the beat at t0 and the beat length over the next WINDOW_BEATS beats."""
    if GRID == "global":
        return t0, 60 / song["bpm"]
    if GRID == "fitted":
        return fitted_grid(song, t0)
    if GRID == "server":  # what the phone uses: the analyser's fitted beat at each mix point
        fitted = song.get("mixOutBeatS") if t0 == song["mixOutS"] else song.get("mixInBeatS")
        return t0, fitted or 60 / song["bpm"]
    beats = np.array(song["beats"])
    i = int(np.argmin(abs(beats - t0)))
    w = beats[i : i + WINDOW_BEATS + 1]
    if len(w) < 8:
        return t0, 60 / song["bpm"]
    k = np.arange(len(w))
    period, anchor = np.polyfit(k, w, 1)
    return float(anchor), float(period)


def tempo_rate(pa, pb):
    """How much faster B must play so its beat length equals A's (half/double time allowed)."""
    r = pb / pa
    best = min((r, r / 2, r * 2), key=lambda c: abs(c - 1))
    return best if abs(best - 1) <= MAX_STRETCH else 1.0


def plan(a, b):
    a0, pa = local_grid(a, a["mixOutS"])
    b0, pb = local_grid(b, b["mixInS"])
    rate = tempo_rate(pa, pb)
    in_s = min(14, MIX_IN_BEATS * pa)
    out_s = min(8, MIX_OUT_BEATS * pa)
    return {"rate": rate, "beat": pa, "in": in_s, "out": out_s, "a0": a0, "b0": b0}


def render(a, b, pre=16.0, post=24.0):
    """Both decks as heard around the mix, plus the summed mix. Times are relative to B's start."""
    p = plan(a, b)
    xa, xb = load(a), load(b)
    a0 = int((p["a0"] - pre) * SR)
    a_part = xa[:, max(0, a0) : int((p["a0"] + p["in"] + p["out"] + 0.5) * SR)]
    if a0 < 0:
        a_part = np.pad(a_part, ((0, 0), (-a0, 0)))
    total = p["in"] + p["out"] + post
    b_src = xb[:, int(p["b0"] * SR) : int((p["b0"] + total * p["rate"] + 1) * SR)]
    b_part = stretch(b_src, p["rate"])

    n = int((pre + total) * SR)
    deck_a = np.zeros((2, n), np.float32)
    deck_b = np.zeros((2, n), np.float32)
    deck_a[:, : min(n, a_part.shape[1])] = a_part[:, :n]
    start = int(pre * SR)
    m = min(n - start, b_part.shape[1])
    deck_b[:, start : start + m] = b_part[:, :m]

    swap, end, beat = pre + p["in"], pre + p["in"] + p["out"], p["beat"]
    ga = ramp(n, [(0, 1), (swap, 1), (end, 0), (pre + total, 0)])
    gb = ramp(n, [(0, 0), (pre, 0), (swap, 1), (pre + total, 1)])
    cut_a = ramp(n, [(0, 0), (swap, 0), (swap + beat, 1), (pre + total, 1)])
    cut_b = ramp(n, [(0, 1), (swap, 1), (swap + beat, 0), (pre + total, 0)])
    played_a = (deck_a * (1 - cut_a) + low_shelf(deck_a, BASS_CUT_DB) * cut_a) * ga
    played_b = (deck_b * (1 - cut_b) + low_shelf(deck_b, BASS_CUT_DB) * cut_b) * gb
    return deck_a, deck_b, (played_a + played_b) * headroom(n, p, pre, total), p, pre


# Two mastered songs summed clip; the phone dips its master by this much while both play.
MIX_HEADROOM = 0.71  # -3 dB


def headroom(n, p, pre, total):
    """Master gain over the mix: down to MIX_HEADROOM across the overlap, back after it."""
    beat = p["beat"]
    end = pre + p["in"] + p["out"]
    return ramp(n, [(0, 1), (pre, 1), (pre + 2 * beat, MIX_HEADROOM), (end, MIX_HEADROOM), (end + 4 * beat, 1), (pre + total, 1)])


_DEMUCS = None


def separate(x):
    """Stems of stereo audio at SR: dict drums/bass/other/vocals (htdemucs, CPU)."""
    global _DEMUCS
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    if _DEMUCS is None:
        _DEMUCS = get_model("htdemucs")
        _DEMUCS.eval()
    with torch.no_grad():
        out = apply_model(_DEMUCS, torch.from_numpy(np.ascontiguousarray(x))[None], device="cpu", shifts=0, overlap=0.1, progress=False)[0]
    return {name: out[i].numpy().astype(np.float32) for i, name in enumerate(_DEMUCS.sources)}


def render_stems(a, b, pre=16.0, post=24.0):
    """The same hand-over a DJ does with stems, on the same beat grid as render().

    Bars counted from the mix point (4 beats each):
      bars 1-2   B's drums ride in under A
      bars 3-4   A's vocals fade out (two vocals never overlap); B's music comes in
      bar 5      bass swap on the downbeat: A's bass out, B's bass in; B's vocals enter
      bars 5-6   A's drums and music fade out
    """
    p = plan(a, b)
    xa, xb = load(a), load(b)
    a0 = int((p["a0"] - pre) * SR)
    a_part = xa[:, max(0, a0) : int((p["a0"] + p["in"] + p["out"] + 0.5) * SR)]
    if a0 < 0:
        a_part = np.pad(a_part, ((0, 0), (-a0, 0)))
    total = p["in"] + p["out"] + post
    b_src = xb[:, int(p["b0"] * SR) : int((p["b0"] + total * p["rate"] + 1) * SR)]
    b_part = stretch(b_src, p["rate"])
    sa, sb = separate(a_part), separate(b_part)

    n = int((pre + total) * SR)
    start = int(pre * SR)

    def place(x, at):
        y = np.zeros((2, n), np.float32)
        m = min(n - at, x.shape[1])
        y[:, at : at + m] = x[:, :m]
        return y

    A = {k: place(v, 0) for k, v in sa.items()}
    B = {k: place(v, start) for k, v in sb.items()}
    beat = p["beat"]
    t = lambda beats: pre + beats * beat  # noqa: E731
    end_t = pre + total
    g = lambda pts: ramp(n, [(0, pts[0][1])] + pts + [(end_t, pts[-1][1])])  # noqa: E731
    mix = (
        A["vocals"] * g([(t(8), 1), (t(14), 0)])
        + A["other"] * g([(t(16), 1), (t(24), 0)])
        + A["drums"] * g([(t(16), 1), (t(24), 0)])
        + A["bass"] * g([(t(16) - 0.01, 1), (t(16), 0)])
        + B["drums"] * g([(t(0), 0), (t(8), 1)])
        + B["other"] * g([(t(8), 0), (t(16), 1)])
        + B["bass"] * g([(t(16) - 0.01, 0), (t(16), 1)])
        + B["vocals"] * g([(t(16) - 0.01, 0), (t(16), 1)])
    )
    return mix * headroom(n, p, pre, total), p, pre


def score(a, b, deck_a, deck_b, p, pre):
    """Each deck's beats against one shared grid (A's, from the mix point), bar by bar.

    Cross-correlating two different songs' onsets locks onto syncopation as easily as the beat;
    measuring each deck against the same click grid and differencing does not.
    """
    ea, eb = onset_env(deck_a), onset_env(deck_b)
    beat = p["beat"]
    end = pre + p["in"] + p["out"]
    lags = []
    t = pre
    while t + 4 * beat <= end + 1e-6:
        grid = t + np.arange(8) * beat  # two bars per window, one bar step
        grid = grid[grid <= end]
        lags.append(grid_phase_ms(eb, grid, beat) - grid_phase_ms(ea, grid, beat))
        t += 4 * beat
    return {
        "a": a["title"],
        "b": b["title"],
        "bpm": f"{a['bpm']:.1f} → {b['bpm']:.1f}",
        "rate": round(p["rate"], 4),
        "matched": p["rate"] != 1.0,
        "lagMs": int(np.median(lags)) if lags else None,
        "driftMs": (lags[-1] - lags[0]) if len(lags) > 1 else None,
        "windows": len(lags),
    }


def write_wav(path, x):
    x = np.clip(x, -1, 1)
    c = av.open(str(path), "w")
    s = c.add_stream("pcm_s16le", rate=SR, layout="stereo")
    f = av.AudioFrame.from_ndarray((x.T * 32767).astype(np.int16).reshape(1, -1), format="s16", layout="stereo")
    f.sample_rate = SR
    for pkt in s.encode(f):
        c.mux(pkt)
    for pkt in s.encode(None):
        c.mux(pkt)
    c.close()


# --- cli ---------------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--limit", type=int, default=200)
    r = sub.add_parser("render")
    r.add_argument("a")
    r.add_argument("b")
    r.add_argument("--stems", action="store_true", help="also render the stem hand-over")
    bn = sub.add_parser("bench")
    bn.add_argument("--n", type=int, default=40)
    bn.add_argument("--seed", type=int, default=7)
    bn.add_argument("--matchable", action="store_true", help="every pair close enough in tempo to beat-match")
    for p in (r, bn):
        p.add_argument("--grid", choices=["server", "fitted", "local", "global"], default="server")
    args = ap.parse_args()
    global GRID
    GRID = getattr(args, "grid", GRID)

    if args.cmd == "fetch":
        return fetch(args.limit)
    lib = library()
    OUT.mkdir(exist_ok=True)
    if args.cmd == "render":
        a, b = lib[args.a], lib[args.b]
        deck_a, deck_b, mix, p, pre = render(a, b)
        write_wav(OUT / f"{safe(a['songId'])}__{safe(b['songId'])}.wav", mix)
        print(json.dumps(score(a, b, deck_a, deck_b, p, pre)))
        if args.stems:
            smix, _, _ = render_stems(a, b)
            write_wav(OUT / f"{safe(a['songId'])}__{safe(b['songId'])}.stems.wav", smix)
        return
    ids = list(lib)
    random.Random(args.seed).shuffle(ids)
    pairs = [(ids[i], ids[(i + 1) % len(ids)]) for i in range(min(args.n, len(ids)))]
    if args.matchable:
        pairs = [
            (ia, ib)
            for ia in ids
            for ib in ids
            if ia != ib and tempo_rate(60 / lib[ia]["bpm"], 60 / lib[ib]["bpm"]) != 1.0
        ][: args.n]
    rows = []
    for ia, ib in pairs:
        a, b = lib[ia], lib[ib]
        try:
            deck_a, deck_b, _, p, pre = render(a, b)
            rows.append(score(a, b, deck_a, deck_b, p, pre))
            print(json.dumps(rows[-1]), file=sys.stderr)
        except Exception as e:  # a broken file shouldn't stop the bench
            print(f"skip {a['title']} → {b['title']}: {e}", file=sys.stderr)
    matched = [r for r in rows if r["matched"] and r["lagMs"] is not None]
    tight = [r for r in matched if abs(r["lagMs"]) <= 20]
    lines = [
        f"# Mix bench: {len(rows)} pairs",
        "",
        f"Tempo-matched: {len(matched)} of {len(rows)} (the rest are over {int(MAX_STRETCH * 100)}% apart and just crossfade).",
        f"Beats within 20 ms: {len(tight)} of {len(matched)} matched mixes.",
        f"Median |lag| {int(np.median([abs(r['lagMs']) for r in matched])) if matched else '-'} ms, median |drift| {int(np.median([abs(r['driftMs'] or 0) for r in matched])) if matched else '-'} ms.",
        "",
        "| A | B | BPM | rate | lag ms | drift ms |",
        "|---|---|---|---|---|---|",
    ]
    lines += [f"| {r['a']} | {r['b']} | {r['bpm']} | {r['rate']} | {r['lagMs']} | {r['driftMs']} |" for r in rows]
    (OUT / "bench.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines[:4]))


if __name__ == "__main__":
    main()
