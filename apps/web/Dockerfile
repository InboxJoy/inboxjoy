FROM node:22.23.4-bookworm-slim AS app

LABEL org.opencontainers.image.source="https://github.com/inboxjoy/inboxjoy"

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web

RUN pnpm install --frozen-lockfile
RUN pnpm build:packages

# One image serves every edition. The edition (cloud or selfhost) is read from
# INBOXJOY_EDITION at request time, so never add a NEXT_PUBLIC_ variable for it:
# it would be frozen into the bundle at build time.
#
# NEXT_PUBLIC_API_BASE_URL is deliberately NOT set. The web app then calls the
# same-origin /api path (apps/web/lib/api.ts), which both our Caddy and the
# self-host Caddy proxy to the API. Setting it to a relative "/api" at build
# time would break auth-client.ts, which needs an absolute URL while prerendering.
#
# NEXT_PUBLIC_* values are inlined into the client bundle during `next build`,
# so they must arrive as build args. Passing them only at runtime ships
# `undefined` to the browser. The defaults leave analytics off (no token, no
# host), so the prebuilt public images report nothing anywhere. Our own
# production build passes real values as build args too.
ARG NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=""
# Empty host = PostHog's public cloud. Only used when a project token is set.
ARG NEXT_PUBLIC_POSTHOG_HOST=""
ARG NEXT_PUBLIC_POSTHOG_UI_HOST="https://us.posthog.com"
ARG NEXT_PUBLIC_TURNSTILE_SITEKEY=""
ENV NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=$NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN \
    NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST \
    NEXT_PUBLIC_POSTHOG_UI_HOST=$NEXT_PUBLIC_POSTHOG_UI_HOST \
    NEXT_PUBLIC_TURNSTILE_SITEKEY=$NEXT_PUBLIC_TURNSTILE_SITEKEY

RUN pnpm --filter @inboxjoy/web build

WORKDIR /app/apps/web
ENV NODE_ENV=production
EXPOSE 3000
RUN chown -R node:node /app
USER node
CMD ["pnpm", "start"]
