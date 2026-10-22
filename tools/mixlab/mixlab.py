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


def tempo_rate(a, b):
    r = a["bpm"] / b["bpm"]
    best = min((r, r / 2, r * 2), key=lambda c: abs(c - 1))
    return best if abs(best - 1) <= MAX_STRETCH else 1.0


def plan(a, b):
    rate = tempo_rate(a, b)
    beat = 60 / a["bpm"]
    in_s = min(14, MIX_IN_BEATS * beat)
    out_s = min(8, MIX_OUT_BEATS * beat)
    return {"rate": rate, "beat": beat, "in": in_s, "out": out_s}


def render(a, b, pre=16.0, post=24.0):
    """Both decks as heard around the mix, plus the summed mix. Times are relative to B's start."""
    p = plan(a, b)
    xa, xb = load(a), load(b)
    a0 = int((a["mixOutS"] - pre) * SR)
    a_part = xa[:, max(0, a0) : int((a["mixOutS"] + p["in"] + p["out"] + 0.5) * SR)]
    if a0 < 0:
        a_part = np.pad(a_part, ((0, 0), (-a0, 0)))
    total = p["in"] + p["out"] + post
    b_src = xb[:, int(b["mixInS"] * SR) : int((b["mixInS"] + total * p["rate"] + 1) * SR)]
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
    return deck_a, deck_b, played_a + played_b, p, pre


def score(a, b, deck_a, deck_b, p, pre):
    ea, eb = onset_env(deck_a), onset_env(deck_b)
    s, e = int(pre * 100), int((pre + p["in"] + p["out"]) * 100)
    win = max(200, int(4 * p["beat"] * 100))  # one bar, at least 2 s
    lags = []
    for w0 in range(s, max(s + 1, e - win), win // 2):
        lag, c = lag_ms(ea[w0 : w0 + win], eb[w0 : w0 + win], p["beat"])
        if c > 0.2:
            lags.append(lag)
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
    bn = sub.add_parser("bench")
    bn.add_argument("--n", type=int, default=40)
    bn.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    if args.cmd == "fetch":
        return fetch(args.limit)
    lib = library()
    OUT.mkdir(exist_ok=True)
    if args.cmd == "render":
        a, b = lib[args.a], lib[args.b]
        deck_a, deck_b, mix, p, pre = render(a, b)
        write_wav(OUT / f"{safe(a['songId'])}__{safe(b['songId'])}.wav", mix)
        print(json.dumps(score(a, b, deck_a, deck_b, p, pre)))
        return
    ids = list(lib)
    random.Random(args.seed).shuffle(ids)
    pairs = [(ids[i], ids[(i + 1) % len(ids)]) for i in range(min(args.n, len(ids)))]
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
        "",
        "| A | B | BPM | rate | lag ms | drift ms |",
        "|---|---|---|---|---|---|",
    ]
    lines += [f"| {r['a']} | {r['b']} | {r['bpm']} | {r['rate']} | {r['lagMs']} | {r['driftMs']} |" for r in rows]
    (OUT / "bench.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines[:4]))


if __name__ == "__main__":
    main()
