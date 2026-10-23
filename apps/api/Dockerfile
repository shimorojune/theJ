FROM node:24-slim
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
# CPU only: skip onnxruntime-node's 300 MB CUDA download (it kept dropping mid-build).
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN pnpm install --frozen-lockfile --prod --filter @thej/api...
COPY packages packages
COPY apps/api apps/api
WORKDIR /repo/apps/api
# Bake the embedding model into the image: no download at runtime, loud failure at build.
ENV HF_HOME=/opt/hf
RUN node --import tsx -e "import('/repo/packages/core/src/embed.ts').then((m) => m.embedText('warm up'))"
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/index.ts"]
