# syntax=docker/dockerfile:1
#
# Multi-stage build for Gelp, a Next.js 15 (App Router) standalone server.
# Build context MUST be the repository root, e.g.:
#   podman build -f deploy/Dockerfile -t gelp:latest .
#
# Both stages use node:22-alpine (an active LTS with official ARM64 and AMD64
# images), so this builds correctly on ARM64 hosts (Graviton / Apple Silicon)
# as well as AMD64. The database is Postgres over the network (see
# lib/db/index.ts), so no native addons are compiled and no build toolchain is
# needed.

# ---------------------------------------------------------------------------
# Stage 1: deps + build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

# Disable Next.js telemetry during the build so CI/server logs stay quiet.
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# Install dependencies first so this layer is cached unless package files change.
COPY package.json package-lock.json* ./
RUN npm ci

# Values Next.js inlines into the client bundle at build time.
#
# `NEXT_PUBLIC_*` variables are not read at runtime: `npm run build` substitutes
# them into the JavaScript that ships to the browser, and whatever is in the
# gelp-env Secret afterwards cannot change what was already compiled. Since
# .dockerignore excludes `.env*` from the build context — deliberately, so no
# secret is ever baked into an image — they have to arrive as build args
# instead. deploy.sh reads them out of .env.prod and passes them here.
#
# Both are public by design: one is a browser API key restricted in the Google
# console, the other a project number that appears in Google's own error
# messages. Nothing secret belongs in this mechanism.
ARG NEXT_PUBLIC_GOOGLE_PICKER_KEY
ARG NEXT_PUBLIC_GOOGLE_PROJECT_NUMBER
ENV NEXT_PUBLIC_GOOGLE_PICKER_KEY=$NEXT_PUBLIC_GOOGLE_PICKER_KEY
ENV NEXT_PUBLIC_GOOGLE_PROJECT_NUMBER=$NEXT_PUBLIC_GOOGLE_PROJECT_NUMBER

# Copy the rest of the source and build the standalone output.
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

WORKDIR /app

# node:22-alpine already ships a non-root "node" user (uid/gid 1000); reuse it
# instead of creating a new one.

# The standalone output is a self-contained server: it includes a minimal
# node_modules with only the deps actually needed at runtime, plus server.js.
COPY --from=builder --chown=node:node /app/.next/standalone ./
# Static assets are not included in the standalone output and must be copied
# in manually, nested under .next/static relative to server.js.
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
# Public assets (favicon, images, etc.) are also excluded from standalone.
COPY --from=builder --chown=node:node /app/public ./public

USER node

EXPOSE 3000

CMD ["node", "server.js"]
