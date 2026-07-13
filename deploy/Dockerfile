# syntax=docker/dockerfile:1
#
# Multi-stage build for Gelp, a Next.js 15 (App Router) standalone server.
# Build context MUST be the repository root, e.g.:
#   docker build -f deploy/Dockerfile -t gelp:latest .
#
# Both stages use node:20-alpine, which has official ARM64 and AMD64 images,
# so this Dockerfile builds correctly on ARM64 hosts (e.g. Graviton/Apple
# Silicon servers) as well as AMD64.

# ---------------------------------------------------------------------------
# Stage 1: deps + build
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder

# better-sqlite3 ships a native addon that must be compiled from source on
# Alpine (musl) since prebuilt binaries usually target glibc. python3, make
# and g++ are the toolchain node-gyp needs to do that compile.
RUN apk add --no-cache python3 make g++

# Disable Next.js telemetry during the build so CI/server logs stay quiet.
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# Install dependencies first so this layer is cached unless package files change.
COPY package.json package-lock.json* ./
RUN npm ci

# Copy the rest of the source and build the standalone output.
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:20-alpine AS runner

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

WORKDIR /app

# node:20-alpine already ships a non-root "node" user (uid/gid 1000); reuse it
# instead of creating a new one.

# The standalone output is a self-contained server: it includes a minimal
# node_modules with only the deps actually needed at runtime, plus server.js.
COPY --from=builder --chown=node:node /app/.next/standalone ./
# Static assets are not included in the standalone output and must be copied
# in manually, nested under .next/static relative to server.js.
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
# Public assets (favicon, images, etc.) are also excluded from standalone.
COPY --from=builder --chown=node:node /app/public ./public

# SQLite lives on a mounted volume in production (see deploy/k8s/30-pvc.yaml);
# create the mount point ahead of time so it is owned by the non-root user
# even before the volume is attached.
RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 3000

CMD ["node", "server.js"]
