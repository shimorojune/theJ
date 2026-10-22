# streamer: yt-dlp nightly + Deno (JS challenges) + bgutil PO-token plugin + ffmpeg + Essentia.
# amd64 only (Essentia ships no arm64 wheel); on an Apple Silicon Mac build with --platform linux/amd64.
# Rebuild nightly so yt-dlp stays current; most YouTube breakages are fixed upstream in a day or two.
FROM --platform=linux/amd64 node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* && corepack enable
ARG CACHEBUST
RUN pip install --break-system-packages -q -U --pre "yt-dlp[default]" deno "bgutil-ytdlp-pot-provider==2.0.2" essentia
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/workers/package.json apps/workers/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
RUN pnpm install --frozen-lockfile --prod --filter @thej/workers...
COPY packages packages
COPY apps/workers apps/workers
WORKDIR /repo/apps/workers
CMD ["node", "--import", "tsx", "src/streamer/index.ts"]
