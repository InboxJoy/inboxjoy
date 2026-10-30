FROM node:22.23.4-bookworm-slim AS app

LABEL org.opencontainers.image.source="https://github.com/inboxjoy/inboxjoy"

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api

RUN pnpm install --frozen-lockfile
RUN pnpm build:packages
RUN pnpm --filter @inboxjoy/api build

# The same image also runs migrations: the self-host stack starts it with
# `pnpm exec tsx ../../packages/db/src/migrate.ts`, so keep tsx installed.
WORKDIR /app/apps/api
ENV NODE_ENV=production
EXPOSE 3001
RUN chown -R node:node /app
USER node
CMD ["pnpm", "start"]
