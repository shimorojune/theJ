// Offline time-stretch and pitch-shift with Signalsmith Stretch, for the DJ lab (apps/lab).
//
//   stretch IN.f32 OUT.f32 SAMPLE_RATE OUT_FRAMES RATE SEMITONES RAMP_FROM RAMP_TO
//
// IN is planar stereo float32 (all of the left channel, then all of the right), read from its
// first frame. OUT_FRAMES of output are written the same way. The playback rate starts at RATE
// and the pitch at SEMITONES; between output frames RAMP_FROM and RAMP_TO both move linearly
// to 1 and 0 (a mix easing back to the song's own tempo and key). Output frame 0 lines up with
// input frame 0: the stretcher's latency is taken out.
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "signalsmith-stretch/signalsmith-stretch.h"

using Stretch = signalsmith::stretch::SignalsmithStretch<float>;

struct Planar {
  float *data;
  long length;
  long offset;
  float *operator[](int c) { return data + c * length + offset; }
};

int main(int argc, char **argv) {
  if (argc < 9) {
    std::fprintf(stderr, "usage: stretch IN.f32 OUT.f32 SR OUT_FRAMES RATE SEMIS RAMP_FROM RAMP_TO\n");
    return 2;
  }
  const char *inPath = argv[1];
  const char *outPath = argv[2];
  const double sr = std::atof(argv[3]);
  const long outFrames = std::atol(argv[4]);
  const double rate0 = std::atof(argv[5]);
  const double semis0 = std::atof(argv[6]);
  const long rampFrom = std::atol(argv[7]);
  const long rampTo = std::atol(argv[8]);

  FILE *f = std::fopen(inPath, "rb");
  if (!f) return 1;
  std::fseek(f, 0, SEEK_END);
  const long inFrames = std::ftell(f) / (2 * sizeof(float));
  std::fseek(f, 0, SEEK_SET);
  std::vector<float> in(inFrames * 2);
  if (std::fread(in.data(), sizeof(float), in.size(), f) != in.size()) return 1;
  std::fclose(f);

  auto at = [&](long frame, double from, double to) {
    if (frame <= rampFrom || rampTo <= rampFrom) return frame <= rampFrom ? from : to;
    if (frame >= rampTo) return to;
    return from + (to - from) * double(frame - rampFrom) / double(rampTo - rampFrom);
  };

  Stretch stretch;
  stretch.presetDefault(2, float(sr));
  stretch.setTransposeSemitones(float(semis0));
  Planar input{in.data(), inFrames, 0};
  // Prime with enough input that output frame 0 is input frame 0.
  const long seek = stretch.outputSeekLength(float(rate0));
  stretch.outputSeek(input, int(seek));
  input.offset = seek;

  std::vector<float> out(outFrames * 2, 0.0f);
  Planar output{out.data(), outFrames, 0};
  const long block = 256;
  double inPos = double(seek);
  for (long o = 0; o < outFrames; o += block) {
    const long n = std::min(block, outFrames - o);
    const double r = at(o, rate0, 1.0);
    stretch.setTransposeSemitones(float(at(o, semis0, 0.0)));
    const long from = long(inPos);
    inPos += r * double(n);
    long take = long(inPos) - from;
    if (from + take > inFrames) take = std::max(0L, inFrames - from);
    input.offset = from;
    output.offset = o;
    stretch.process(input, int(take), output, int(n));
  }

  FILE *g = std::fopen(outPath, "wb");
  if (!g) return 1;
  std::fwrite(out.data(), sizeof(float), out.size(), g);
  std::fclose(g);
  return 0;
}
