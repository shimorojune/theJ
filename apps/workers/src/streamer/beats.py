"""Beat grid, tempo and key for one audio file. Prints JSON. Used by the streamer after each pull."""
import json
import sys

import essentia.standard as es

audio = es.MonoLoader(filename=sys.argv[1], sampleRate=44100)()
bpm, beats, confidence, _, _ = es.RhythmExtractor2013(method="multifeature")(audio)
key, scale, _strength = es.KeyExtractor()(audio)
print(
    json.dumps(
        {
            "bpm": round(float(bpm), 2),
            "beats": [round(float(b), 3) for b in beats],
            "confidence": round(float(confidence), 3),
            "key": key,
            "scale": scale,
            "durationS": round(len(audio) / 44100, 2),
        }
    )
)
