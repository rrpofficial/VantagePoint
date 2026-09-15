# vantagepoint-web (US-9.2, PRD FR-8.1/8.3)
#
# Builds the SPA, then serves the static bundle from Caddy. The runtime image
# contains no Node and no source — only compiled assets and a web server.
#
# ADR-013: the PII masker ships INSIDE this bundle, because masking must happen
# in the browser before anything reaches the API.

# ---------------------------------------------------------------- build stage
FROM node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /build

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY tsconfig.base.json tsconfig.json ./

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @vantagepoint/app-web build

# -------------------------------------------------------------- runtime stage
FROM caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS runtime

ARG VANTAGEPOINT_UID=1000
ARG VANTAGEPOINT_GID=1000

COPY --from=build /build/apps/web/dist /srv
COPY docker/Caddyfile /etc/caddy/Caddyfile

# Caddy needs writable config and data paths; everything else stays read-only.
RUN addgroup -g "${VANTAGEPOINT_GID}" -S vantagepoint 2>/dev/null || true \
 && adduser -u "${VANTAGEPOINT_UID}" -G vantagepoint -S vantagepoint 2>/dev/null || true \
 && mkdir -p /config /data \
 && chown -R "${VANTAGEPOINT_UID}:${VANTAGEPOINT_GID}" /config /data /srv

USER ${VANTAGEPOINT_UID}:${VANTAGEPOINT_GID}

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=5 \
  CMD wget -q --spider http://127.0.0.1:80/ || exit 1

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
