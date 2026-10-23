"""Stem separation for the DJ lab (apps/lab), with htdemucs.

    python tools/mixlab/stems.py envelopes SONG.m4a OUT.json
        how loud each stem (drums, bass, other, vocals) is every 100 ms over the whole song,
        so the lab can see where the vocals are
    python tools/mixlab/stems.py serve
        a worker: reads JSON lines {"in": raw, "out": prefix, "sr": 48000} (stereo float32,
        interleaved), writes prefix.drums.f32 ... prefix.vocals.f32 at the same rate and
        length, answers {"ok": true} per line

Runs on the GPU (MPS) when there is one.
"""

import json
import os
import sys

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import av  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
import torchaudio.functional as AF  # noqa: E402
from demucs.apply import apply_model  # noqa: E402
from demucs.pretrained import get_model  # noqa: E402

DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
_MODEL = None


def model():
    global _MODEL
    if _MODEL is None:
        _MODEL = get_model("htdemucs")
        _MODEL.eval()
        _MODEL.to(DEVICE)
    return _MODEL


def separate(x, sr):
    """Stereo float32 (2, n) at sr -> dict of stems at sr, same length."""
    m = model()
    t = torch.from_numpy(np.ascontiguousarray(x))
    if sr != m.samplerate:
        t = AF.resample(t, sr, m.samplerate)
    with torch.no_grad():
        out = apply_model(m, t[None], device=DEVICE, shifts=0, overlap=0.1, progress=False)[0].cpu()
    stems = {}
    for i, name in enumerate(m.sources):
        s = out[i]
        if sr != m.samplerate:
            s = AF.resample(s, m.samplerate, sr)
        s = s.numpy().astype(np.float32)
        n = x.shape[1]
        stems[name] = s[:, :n] if s.shape[1] >= n else np.pad(s, ((0, 0), (0, n - s.shape[1])))
    return stems


def load(path, sr=44100):
    c = av.open(path)
    r = av.AudioResampler(format="fltp", layout="stereo", rate=sr)
    parts = []
    for frame in c.decode(c.streams.audio[0]):
        parts.extend(f.to_ndarray() for f in r.resample(frame))
    parts.extend(f.to_ndarray() for f in r.resample(None))
    return np.concatenate(parts, axis=1).astype(np.float32)


def envelopes(src, dest):
    sr = 44100
    x = load(src, sr)
    stems = separate(x, sr)
    hop = sr // 10
    out = {"hz": 10}
    for name, s in stems.items():
        mono = s.mean(axis=0)
        n = len(mono) // hop
        rms = np.sqrt((mono[: n * hop].reshape(n, hop) ** 2).mean(axis=1) + 1e-12)
        out[name] = [round(float(v), 1) for v in 20 * np.log10(rms)]
    with open(dest, "w") as f:
        json.dump(out, f)


def serve():
    model()
    for line in sys.stdin:
        job = json.loads(line)
        x = np.fromfile(job["in"], dtype=np.float32).reshape(-1, 2).T
        stems = separate(x, job.get("sr", 48000))
        for name, s in stems.items():
            np.ascontiguousarray(s.T).astype(np.float32).tofile(f"{job['out']}.{name}.f32")
        print(json.dumps({"ok": True}), flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "envelopes":
        envelopes(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "serve":
        serve()
