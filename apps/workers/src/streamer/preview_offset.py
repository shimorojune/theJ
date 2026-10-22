"""Where a 30-second store preview sits inside the full song. Prints JSON {offsetS, match}.

Normalised cross-correlation of the two waveforms at 8 kHz, on the preview's middle (store
previews fade in and out). `match` near 1 means the same recording; below ~0.6, don't trust it.
"""
import json
import sys

import essentia.standard as es
import numpy as np

SR = 8000
full = es.MonoLoader(filename=sys.argv[1], sampleRate=SR)().astype(np.float64)
prev = es.MonoLoader(filename=sys.argv[2], sampleRate=SR)().astype(np.float64)

trim = 5 * SR
p = prev[trim : len(prev) - trim] if len(prev) > 3 * trim else prev
lead = trim if len(prev) > 3 * trim else 0
p = p - p.mean()
f = full - full.mean()
if len(p) == 0 or len(f) <= len(p):
    print(json.dumps({"offsetS": None, "match": 0}))
    sys.exit(0)

n = len(f) + len(p)
size = 1 << (n - 1).bit_length()
corr = np.fft.irfft(np.fft.rfft(f, size) * np.conj(np.fft.rfft(p, size)), size)[: len(f) - len(p) + 1]
energy = np.concatenate([[0.0], np.cumsum(f * f)])
window = energy[len(p) :] - energy[: len(f) - len(p) + 1]
ncc = corr / (np.sqrt(np.maximum(window, 1e-12)) * np.sqrt((p * p).sum()) + 1e-12)
i = int(np.argmax(ncc))
print(json.dumps({"offsetS": round((i - lead) / SR, 4), "match": round(float(ncc[i]), 3)}))
