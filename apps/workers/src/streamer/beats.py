"""Beat grid, tempo, key and mix points for one audio file. Prints JSON. Used by the streamer
after each pull.

Mix points: the next song comes in on the first beat after a short intro, and this one hands
over 8 bars before its end, on a beat. At each point the beat grid is then fitted to the song's
own onsets over the mix window (the period within 2% of the song-wide bpm, the phase within
60 ms of the tracker's beat), the way a DJ nudges a grid by hand. Song-wide bpm drifts 100 to
250 ms over a 24-beat mix on many songs; the fitted grid holds within about 20 ms
(tools/mixlab bench).
"""
import json
import sys

import essentia.standard as es
import numpy as np

SR = 44100
WINDOW_BEATS = 24  # 16 beats in, 8 out: the phone's mix


def onset_env(mono):
    """Spectral flux (log magnitude), 10 ms hop. Same as tools/mixlab."""
    hop, n = 441, 2048
    frames = np.lib.stride_tricks.sliding_window_view(np.pad(mono, (n // 2, n // 2)), n)[::hop]
    out = np.empty(len(frames) - 1, np.float32)
    win = np.hanning(n).astype(np.float32)
    # Chunked so a long song never holds every spectrum at once.
    for i in range(0, len(frames), 2048):
        mag = np.log1p(10 * np.abs(np.fft.rfft(frames[i : i + 2049] * win, axis=1)))
        d = np.maximum(np.diff(mag, axis=0), 0).sum(axis=1)
        out[i : i + len(d)] = d
    flux = out - np.convolve(out, np.ones(50) / 50, mode="same")
    return np.maximum(flux, 0)


def fit_grid(env, t0, base):
    """(anchor, period) that put the most onset energy on WINDOW_BEATS beats from about t0."""
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
    for a2 in anchor + np.arange(-0.005, 0.0051, 0.001):
        e = energy(a2, period)
        if e > best[0]:
            best = (e, a2, period)
    return float(best[1]), float(best[2])


audio = es.MonoLoader(filename=sys.argv[1], sampleRate=SR)()
bpm, beats, confidence, _, _ = es.RhythmExtractor2013(method="multifeature")(audio)
key, scale, _strength = es.KeyExtractor()(audio)
duration = len(audio) / SR
beats = [float(b) for b in beats]

beat = 60 / bpm if bpm > 0 else 0.6
mix_in = next((b for b in beats if b >= 1.5), min(2.0, duration))
out_target = duration - 32 * beat
mix_out = next((b for b in reversed(beats) if b <= out_target), max(mix_in + 10, duration - 10))
mix_in_beat = mix_out_beat = None
if bpm > 0 and beats:
    env = onset_env(audio)
    mix_in, mix_in_beat = fit_grid(env, mix_in, beat)
    mix_out, mix_out_beat = fit_grid(env, mix_out, beat)

print(
    json.dumps(
        {
            "bpm": round(float(bpm), 2),
            "beats": [round(b, 3) for b in beats],
            "confidence": round(float(confidence), 3),
            "key": key,
            "scale": scale,
            "durationS": round(duration, 2),
            "mixInS": round(mix_in, 4),
            "mixOutS": round(mix_out, 4),
            "mixInBeatS": None if mix_in_beat is None else round(mix_in_beat, 6),
            "mixOutBeatS": None if mix_out_beat is None else round(mix_out_beat, 6),
        }
    )
)
