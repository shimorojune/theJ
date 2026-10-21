# planner + analysis. Command picks the entrypoint (see infra/dokploy/thej.compose.yml).
FROM oven/bun:1.4
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json bun.lock ./
COPY apps/workers/package.json apps/workers/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN bun install --frozen-lockfile --production --filter @thej/workers
COPY packages packages
COPY apps/workers apps/workers
WORKDIR /repo/apps/workers
