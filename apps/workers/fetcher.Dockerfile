# fetcher: yt-dlp nightly + Deno (JS challenges) + bgutil PO-token plugin + ffmpeg.
# Rebuild nightly so yt-dlp stays current; most YouTube breakages are fixed upstream in a day or two.
FROM oven/bun:1.4
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ARG CACHEBUST
RUN pip install --break-system-packages -q -U --pre "yt-dlp[default]" deno "bgutil-ytdlp-pot-provider==2.0.2"
WORKDIR /repo
COPY package.json bun.lock ./
COPY apps/workers/package.json apps/workers/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN bun install --frozen-lockfile --production --filter @thej/workers
COPY packages packages
COPY apps/workers apps/workers
WORKDIR /repo/apps/workers
CMD ["bun", "src/fetcher/index.ts"]
