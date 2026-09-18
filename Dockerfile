# ── NineDeploy container image ───────────────────────────────────────────
# NOTE: the recommended production setup is bare-metal (install.sh + systemd)
# because the core needs direct Docker daemon + PM2 access. This image is for
# CI build verification and OPTIONAL containerized deploys — run it with the
# host Docker socket mounted so the deploy engine can manage sibling containers:
#
#   docker run -d --name ninedeploy \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     --group-add $(getent group docker | cut -d: -f3) \
#     -v ninedeploy-data:/data \
#     -p 3000:3000 \
#     -e NINEDEPLOY_DATA_DIR=/data \
#     -e NINEDEPLOY_DB_PATH=/data/ninedeploy.db \
#     -e NINEDEPLOY_JWT_SECRET=<strong-secret> \
#     -e NINEDEPLOY_PUBLIC_URL=https://your-host \
#     ghcr.io/ninedeploy/ninedeploy
#
# The --group-add is REQUIRED when running as the non-root `ninedeploy` user:
# the host socket is typically root:docker mode 0660, and without the host
# docker group's GID every `docker` call fails with permission denied.
#
# PM2-based services are not available in this mode (the daemon runs in the
# host PID space); Docker-based services and templates work normally.

# ── Stage 1: build the monorepo ──────────────────────────────────────────
FROM node:26-slim AS build
WORKDIR /app

# Native modules (ssh2 -> node-gyp) need a toolchain at install time;
# node:26-slim ships without python3/make/g++ and the install fails
# nondeterministically depending on which optional deps resolve.
RUN apt-get update  && apt-get install -y --no-install-recommends python3 make g++  && rm -rf /var/lib/apt/lists/*

# Node ≥ 26 images no longer bundle corepack, so install pnpm via npm.
# Keep PNPM_VERSION in sync with "packageManager" in package.json.
ARG PNPM_VERSION=11.23.0
RUN npm install -g pnpm@${PNPM_VERSION}

# Copy workspace manifests first for layer-cached installs.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY patches/ ./patches/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY packages/db/package.json packages/db/
COPY packages/schemas/package.json packages/schemas/
COPY packages/sdk/package.json packages/sdk/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/mcp/package.json packages/mcp/
COPY website/package.json website/
RUN pnpm install --frozen-lockfile

# Copy the rest and build (tsc for server/packages, vite for web).
COPY . .
RUN pnpm build

# ── Stage 2: runtime ─────────────────────────────────────────────────────
FROM node:26-slim AS runtime
WORKDIR /app

ARG NIXPACKS_VERSION=1.41.0
ARG TARGETARCH

# docker CLI: the deploy engine shells out to `docker` (via the mounted socket).
# Debian trixie split the CLI out of docker.io into its own docker-cli package —
# docker.io alone no longer provides /usr/bin/docker.
# git: repo checkouts. tini: proper signal handling / zombie reaping as PID 1.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl docker-cli git tini \
  && case "$TARGETARCH" in \
       amd64) NIXPACKS_TARGET="x86_64-unknown-linux-musl"; NIXPACKS_SHA256="0f55de7874507b9cf7502113120bd96f2ab6979f78d10eaf2eb2ade9207b3af6" ;; \
       arm64) NIXPACKS_TARGET="aarch64-unknown-linux-musl"; NIXPACKS_SHA256="912bd02dd2bb6f9c3a9ed965fe8a68b4aa318dc7a2546e2eca6f2806a894ba39" ;; \
       *) echo "Unsupported Nixpacks architecture: $TARGETARCH" >&2; exit 1 ;; \
     esac \
  && NIXPACKS_ASSET="nixpacks-v${NIXPACKS_VERSION}-${NIXPACKS_TARGET}.tar.gz" \
  && curl -fsSL "https://github.com/railwayapp/nixpacks/releases/download/v${NIXPACKS_VERSION}/${NIXPACKS_ASSET}" -o "/tmp/${NIXPACKS_ASSET}" \
  && echo "${NIXPACKS_SHA256}  /tmp/${NIXPACKS_ASSET}" | sha256sum -c - \
  && tar -xzf "/tmp/${NIXPACKS_ASSET}" -C /usr/local/bin nixpacks \
  && chmod 0755 /usr/local/bin/nixpacks \
  && nixpacks --version \
  && rm -f "/tmp/${NIXPACKS_ASSET}" \
  && rm -rf /var/lib/apt/lists/*

# Docker CLI plugins. Debian's `docker.io` ships the bare CLI only, so every
# compose service (`docker compose up`) and every BuildKit build
# (`docker buildx build`, engine:use_buildkit) failed inside this image with
# "'compose' is not a docker command". Pinned + checksum-verified like Nixpacks.
ARG COMPOSE_VERSION=5.5.1
ARG BUILDX_VERSION=0.37.1
RUN case "$TARGETARCH" in \
       amd64) COMPOSE_ARCH="x86_64"; COMPOSE_SHA256="db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576"; \
              BUILDX_SHA256="9447199cdb435f25880548343c128a4b6650e8891ee598905d8d29d39a8e359b" ;; \
       arm64) COMPOSE_ARCH="aarch64"; COMPOSE_SHA256="732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7"; \
              BUILDX_SHA256="e5cc9fe3bbff5cbc91230981f7860e06076110730a2db997082652199042a1f2" ;; \
       *) echo "Unsupported Docker plugin architecture: $TARGETARCH" >&2; exit 1 ;; \
     esac \
  && PLUGINS=/usr/local/lib/docker/cli-plugins \
  && mkdir -p "$PLUGINS" \
  && curl -fsSL "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}" -o "$PLUGINS/docker-compose" \
  && echo "${COMPOSE_SHA256}  $PLUGINS/docker-compose" | sha256sum -c - \
  && curl -fsSL "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-${TARGETARCH}" -o "$PLUGINS/docker-buildx" \
  && echo "${BUILDX_SHA256}  $PLUGINS/docker-buildx" | sha256sum -c - \
  && chmod 0755 "$PLUGINS/docker-compose" "$PLUGINS/docker-buildx" \
  && docker compose version \
  && docker buildx version

# Node ≥ 26 images no longer bundle corepack — see stage 1. Keep in sync with
# "packageManager" in package.json.
ARG PNPM_VERSION=11.23.0
RUN npm install -g pnpm@${PNPM_VERSION}

# Production dependencies only (dev deps are stripped). apps/web's manifest is
# copied just to satisfy the workspace resolution — its deps are never installed
# into the runtime (--filter keeps it to what apps/server imports).
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/.npmrc ./
COPY --from=build /app/patches/ patches/
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/web/package.json apps/web/
COPY --from=build /app/apps/cli/package.json apps/cli/
COPY --from=build /app/packages/db/package.json packages/db/
COPY --from=build /app/packages/schemas/package.json packages/schemas/
COPY --from=build /app/packages/sdk/package.json packages/sdk/
COPY --from=build /app/packages/plugin-sdk/package.json packages/plugin-sdk/
COPY --from=build /app/packages/mcp/package.json packages/mcp/
RUN pnpm install --frozen-lockfile --prod --filter @ninedeploy/server... 

# Compiled output (the templates registry compiles into dist; the web dashboard
# is served by the API itself via @fastify/static with an SPA fallback).
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/db/dist packages/db/dist
# SQL migrations: the server self-migrates at startup via the runtime migrator
# (drizzle-kit is a devDependency and absent here).
COPY --from=build /app/packages/db/src/migrations packages/db/src/migrations
COPY --from=build /app/packages/schemas/dist packages/schemas/dist
COPY --from=build /app/packages/sdk/dist packages/sdk/dist
COPY --from=build /app/packages/plugin-sdk/dist packages/plugin-sdk/dist
COPY --from=build /app/packages/mcp/dist packages/mcp/dist

# Non-root user; /data is the volume mount point for db/repos/logs/backups.
RUN useradd --system --create-home ninedeploy && mkdir -p /data && chown ninedeploy /data
USER ninedeploy

ENV NODE_ENV=production \
    NINEDEPLOY_HOST=0.0.0.0 \
    NINEDEPLOY_PORT=3000 \
    NINEDEPLOY_DATA_DIR=/data \
    NINEDEPLOY_DB_PATH=/data/ninedeploy.db

EXPOSE 3000
VOLUME /data

# The API exposes /health (liveness + DB readiness — a failed DB ping answers
# 503, not 200), so the HEALTHCHECK gates on real readiness and orchestrators
# (compose, k8s, Portainer) can use `depends_on: service_healthy` as-is.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/dist/server.js"]
