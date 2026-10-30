FROM node:22.23.4-bookworm-slim AS app

LABEL org.opencontainers.image.source="https://github.com/inboxjoy/inboxjoy"

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker

RUN pnpm install --frozen-lockfile
RUN pnpm build:packages
RUN pnpm --filter @inboxjoy/worker build

WORKDIR /app/apps/worker
ENV NODE_ENV=production
EXPOSE 8090
RUN chown -R node:node /app
USER node
CMD ["pnpm", "start"]
