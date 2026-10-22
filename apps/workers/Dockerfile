# planner + analysis. Command picks the entrypoint (see infra/dokploy/thej.compose.yml).
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/* \
  && corepack enable
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
# Bake the embedding model into the image: no download at runtime, loud failure at build.
ENV HF_HOME=/opt/hf
RUN node --import tsx -e "import('/repo/packages/core/src/embed.ts').then((m) => m.embedText('warm up'))"
