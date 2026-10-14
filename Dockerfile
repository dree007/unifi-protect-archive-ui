# Unifi Protect Archive UI – production image (docs/selfhosting.md). ONE image for every role:
#   web       node server.js                        (Next.js standalone server, port 3000)
#   worker    node cli/worker-run.mjs               (background worker, no ports)
#   migrate   node cli/migrate.mjs                  (one-shot schema migration)
#   tools     node cli/archive-scan.mjs --dry-run, cli/media-check.mjs, …
# Maintainer build input; end-user compose.yaml pulls a prebuilt image without a build. Contains no
# configuration of a specific installation; everything comes from the environment at runtime.

ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# --- dependencies: all packages, only re-installed when package*.json change -----------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# --- builder: Next.js standalone build + bundled command-line entrypoints ---------------------
FROM deps AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
# Needs neither a database, the NAS, ffmpeg nor any secret.
RUN npm run build && npm run build:cli
# Private media use ffmpeg; the Next image optimizer is disabled. Remove its unused
# native runtime before COPY so these binaries are absent from every published layer.
RUN rm -rf .next/standalone/node_modules/sharp .next/standalone/node_modules/@img

# --- runtime ------------------------------------------------------------------------------------
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS runtime

# Copy the official runtime, not npm/Corepack or their dependencies. A later removal
# from a Node-based stage would leave those files in inherited image layers.
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
COPY --from=deps /usr/local/LICENSE /usr/local/LICENSE
RUN groupadd --gid 1000 node && useradd --uid 1000 --gid node --create-home node

# ffmpeg from Debian for thumbnails (never downloaded at runtime; videos are never transcoded).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && ffmpeg -version | head -n 1

ARG RELEASE_VERSION=1.0.0
ARG SOURCE_URL=https://github.com/dree007/unifi-protect-archive-ui
ARG SOURCE_REVISION=
ARG SOURCE_DIGEST=
ARG SOURCE_DOWNLOAD_URL=
ARG BUILD_CREATED=

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    ARCHIVE_ROOT=/archive \
    THUMBNAIL_CACHE_ROOT=/data/thumbnails \
    FFMPEG_PATH=ffmpeg \
    IMAGE_SOURCE_URL=${SOURCE_DOWNLOAD_URL} \
    APP_BUILD_VERSION=${RELEASE_VERSION}
WORKDIR /app
LABEL org.opencontainers.image.title="Unifi Protect Archive UI" \
      org.opencontainers.image.description="Read-only NAS archive browser for exported UniFi Protect recordings" \
      org.opencontainers.image.version="${RELEASE_VERSION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.created="${BUILD_CREATED}" \
      io.unifi-protect-archive-ui.source-sha256="${SOURCE_DIGEST}"

# Only what runs, owned by root and read-only for the app user: the standalone server with its
# traced node_modules, static assets, the self-contained CLI bundles and the SQL migrations.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/dist/cli ./cli
COPY --from=builder /app/dist/notices ./notices
COPY --from=builder /app/drizzle ./drizzle
COPY LICENSE THIRD_PARTY_NOTICES.md ./

# Preserve the exact native package/source-version ledger for redistribution review.
RUN dpkg-query -W -f='${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n' > /app/notices/native-packages.tsv

# The thumbnail volume takes over this ownership. Pages are request-dynamic; the
# distribution does not require a writable Next cache or /tmp (validated in Docker tests).
RUN mkdir -p /data/thumbnails /app/.next/cache \
  && chown node:node /data/thumbnails /app/.next/cache

USER node
EXPOSE 3000

# Web role by default; compose.yaml sets its own checks per role.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "server.js"]
