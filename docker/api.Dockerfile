# vantagepoint-api (US-9.1, PRD FR-8.1/8.3)
#
# Multi-stage so the runtime carries no compiler, no devDependencies and no tests.
# The base is pinned by digest: a floating tag means two builds of the same commit
# can differ, which defeats the point of shipping a reproducible compliance tool.
#
# glibc, not Alpine — better-sqlite3-multiple-ciphers is a native module and must
# be built against the same libc it will run on (plan risk R9).

# ---------------------------------------------------------------- build stage
FROM node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /build

# Manifests first: this layer is cached until a dependency actually changes,
# so an ordinary source edit does not reinstall the world.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY tsconfig.base.json tsconfig.json ./

RUN pnpm install --frozen-lockfile

# Rebuild the native module against THIS image's libc, not the build host's.
RUN pnpm rebuild better-sqlite3-multiple-ciphers

# Bundle ahead of time. The sources use NodeNext `./app.js` specifiers, which
# Node's type-stripping loader cannot resolve at runtime, and a production image
# should not depend on an experimental flag to boot.
RUN node apps/api/build.mjs

# A separate, minimal dependency tree for the runtime. The bundle inlines all of
# our own code, so the image needs only the handful of external packages listed
# here — building it fresh keeps dev tooling out by construction rather than
# pruning it away afterwards and hoping nothing was missed.
COPY docker/runtime-package.json /runtime/package.json
RUN cd /runtime && npm install --omit=dev --no-audit --no-fund --loglevel=error

# -------------------------------------------------------------- runtime stage
FROM node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS runtime

# Non-root (FR-8.3). UID/GID are build args so bind-mounted files end up owned by
# the invoking host user rather than root (US-9.5).
ARG VANTAGEPOINT_UID=1000
ARG VANTAGEPOINT_GID=1000

RUN groupadd --gid "${VANTAGEPOINT_GID}" vantagepoint 2>/dev/null || true \
 && useradd --uid "${VANTAGEPOINT_UID}" --gid "${VANTAGEPOINT_GID}" --create-home vantagepoint 2>/dev/null || true \
 && mkdir -p /var/lib/vantagepoint \
 && chown -R "${VANTAGEPOINT_UID}:${VANTAGEPOINT_GID}" /var/lib/vantagepoint

WORKDIR /app

# Only the bundle and its minimal runtime tree — no sources, no tests, no compiler.
COPY --from=build --chown=${VANTAGEPOINT_UID}:${VANTAGEPOINT_GID} /runtime/node_modules ./node_modules
COPY --from=build --chown=${VANTAGEPOINT_UID}:${VANTAGEPOINT_GID} /build/apps/api/dist ./dist
COPY --chown=${VANTAGEPOINT_UID}:${VANTAGEPOINT_GID} docker/entrypoint-api.sh /usr/local/bin/entrypoint-api.sh

RUN chmod +x /usr/local/bin/entrypoint-api.sh \
 && find . -name '*.map' -delete

USER ${VANTAGEPOINT_UID}:${VANTAGEPOINT_GID}

ENV NODE_ENV=production \
    VANTAGEPOINT_DATA_DIR=/var/lib/vantagepoint \
    PORT=8080

EXPOSE 8080
VOLUME ["/var/lib/vantagepoint"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint-api.sh"]
CMD ["node", "dist/server.mjs"]
