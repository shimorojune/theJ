FROM oven/bun:1.4 AS base
WORKDIR /repo
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN bun install --frozen-lockfile --production --filter @thej/api
COPY packages packages
COPY apps/api apps/api
WORKDIR /repo/apps/api
EXPOSE 3000
CMD ["bun", "src/index.ts"]
