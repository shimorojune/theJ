FROM node:24-slim
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --prod --filter @thej/api...
COPY packages packages
COPY apps/api apps/api
WORKDIR /repo/apps/api
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/index.ts"]
