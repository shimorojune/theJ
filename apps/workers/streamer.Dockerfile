# streamer: yt-dlp nightly + Deno (JS challenges) + bgutil PO-token plugin + ffmpeg + Essentia.
# amd64 only (Essentia ships no arm64 wheel); on an Apple Silicon Mac build with --platform linux/amd64.
# Rebuild nightly so yt-dlp stays current; most YouTube breakages are fixed upstream in a day or two.
FROM --platform=linux/amd64 node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* && corepack enable
# Stems for DJ hand-overs (stems.py): CPU torch, Demucs, PyAV; the htdemucs weights are baked in
# so a fresh container splits without a download. Before the nightly yt-dlp layer so a CACHEBUST
# rebuild doesn't pull torch again.
RUN pip install --break-system-packages -q "torch==2.5.1+cpu" --extra-index-url https://download.pytorch.org/whl/cpu \
  && pip install --break-system-packages -q demucs==4.1.0 av==13.1.0 "numpy<2" \
  && python3 -c "from demucs.pretrained import get_model; get_model('htdemucs')"
ARG CACHEBUST
RUN pip install --break-system-packages -q -U --pre "yt-dlp[default]" deno "bgutil-ytdlp-pot-provider==2.0.2" essentia
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/workers/package.json apps/workers/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
# CPU only: skip onnxruntime-node's 300 MB CUDA download (it kept dropping mid-build).
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN pnpm install --frozen-lockfile --prod --filter @thej/workers...
COPY packages packages
COPY apps/workers apps/workers
WORKDIR /repo/apps/workers
CMD ["node", "--import", "tsx", "src/streamer/index.ts"]
