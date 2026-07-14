FROM node:24-bookworm-slim AS dependencies

ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/corepack
ENV PATH=/pnpm:$PATH

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY apps/chronolog/package.json apps/chronolog/package.json
COPY apps/chronologd/package.json apps/chronologd/package.json
COPY packages/canonical/package.json packages/canonical/package.json
COPY packages/capabilities/package.json packages/capabilities/package.json
COPY packages/chaos/package.json packages/chaos/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/compiler-sqlite/package.json packages/compiler-sqlite/package.json
COPY packages/control-store/package.json packages/control-store/package.json
COPY packages/crypto/package.json packages/crypto/package.json
COPY packages/ir/package.json packages/ir/package.json
COPY packages/kernels/package.json packages/kernels/package.json
COPY packages/materializer-doltlite/package.json packages/materializer-doltlite/package.json
COPY packages/node-core/package.json packages/node-core/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/react/package.json packages/react/package.json
COPY packages/rpc/package.json packages/rpc/package.json
COPY packages/testkit/package.json packages/testkit/package.json
COPY packages/transport-ssb/package.json packages/transport-ssb/package.json
RUN pnpm install --frozen-lockfile

FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/corepack
ENV PATH=/pnpm:$PATH
ENV NODE_ENV=development

RUN corepack enable && corepack prepare pnpm@10.12.4 --activate \
  && chmod -R a+rX /corepack
WORKDIR /workspace
COPY --from=dependencies /workspace /workspace
COPY tsconfig.base.json tsconfig.json tsconfig.build.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages

EXPOSE 8787 8008
HEALTHCHECK --interval=1s --timeout=2s --start-period=20s --retries=30 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "tsx", "apps/chronologd/src/main.ts"]
