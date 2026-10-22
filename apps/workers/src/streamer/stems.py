"""Stems for the two mix windows of one song, for the phone's DJ hand-over. Prints JSON.

    python3 stems.py <audio> <out_prefix> <in_start_s> <in_len_s> <out_start_s> <out_len_s>

Mix-in window (the song coming in): drums, other, and rest = window - drums - other
(bass and vocals, which enter together on the bass swap).
Mix-out window (the song going out): vocals, bass, and rest = window - vocals - bass
(drums and music, which fade together).

"rest" is the exact remainder, so each window's three files sum to the original audio and the
phone can hand over between the full song and its stems without a seam. Windows start on an
exact sample at 44.1 kHz; the JSON reports the start the files really have.
Needs demucs, torch (CPU) and av; the htdemucs weights are fetched at image build.
Files: <out_prefix>.in-drums.m4a, .in-other.m4a, .in-rest.m4a, .out-vocals.m4a, .out-bass.m4a,
.out-rest.m4a (AAC 192k).
"""
import json
import sys

import av
import numpy as np
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model

SR = 44100
torch.set_num_threads(1)  # the streamer is CPU-capped; one thread keeps the api responsive


def load(path):
    """The whole song as stereo float32 [2, n] at SR (FFmpeg via PyAV, as the phone decodes)."""
    c = av.open(path)
    r = av.AudioResampler(format="fltp", layout="stereo", rate=SR)
    parts = []
    for frame in c.decode(c.streams.audio[0]):
        parts.extend(f.to_ndarray() for f in r.resample(frame))
    parts.extend(f.to_ndarray() for f in r.resample(None))
    c.close()
    return np.concatenate(parts, axis=1).astype(np.float32)


def write(path, x):
    """AAC in MP4; the muxer records the encoder delay, so decoders start on sample 0."""
    c = av.open(path, "w", format="mp4")
    st = c.add_stream("aac", rate=SR, layout="stereo")
    st.bit_rate = 192_000
    x = np.ascontiguousarray(x, np.float32)
    for i in range(0, x.shape[1], 1024):
        f = av.AudioFrame.from_ndarray(np.ascontiguousarray(x[:, i : i + 1024]), format="fltp", layout="stereo")
        f.sample_rate = SR
        f.pts = i
        for pkt in st.encode(f):
            c.mux(pkt)
    for pkt in st.encode(None):
        c.mux(pkt)
    c.close()


model = get_model("htdemucs")
model.eval()


def separate(x):
    with torch.no_grad():
        out = apply_model(model, torch.from_numpy(x)[None], device="cpu", shifts=0, overlap=0.1, progress=False)[0]
    return {name: out[i].numpy() for i, name in enumerate(model.sources)}


audio, prefix = sys.argv[1], sys.argv[2]
in_start, in_len, out_start, out_len = (float(v) for v in sys.argv[3:7])
song = load(audio)


def window(start, length):
    i = max(0, round(start * SR))
    return i / SR, np.ascontiguousarray(song[:, i : i + round(length * SR)])


in_s, x = window(in_start, in_len)
s = separate(x)
write(f"{prefix}.in-drums.m4a", s["drums"])
write(f"{prefix}.in-other.m4a", s["other"])
write(f"{prefix}.in-rest.m4a", x - s["drums"] - s["other"])

out_s, x = window(out_start, out_len)
s = separate(x)
write(f"{prefix}.out-vocals.m4a", s["vocals"])
write(f"{prefix}.out-bass.m4a", s["bass"])
write(f"{prefix}.out-rest.m4a", x - s["vocals"] - s["bass"])

print(json.dumps({"inS": in_s, "outS": out_s}))
