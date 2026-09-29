# EDEN//0 — container image.
#
# Two stages: build the client bundle with the full toolchain, then ship a small
# runtime that only needs Node and the server. The simulation itself is plain
# TypeScript with no native dependencies, so there is no build step for the
# server beyond having `tsx` available to run it.

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY tests ./tests
# The type-check covers the tests, and the balance tests import the harness.
COPY scripts ./scripts
RUN npm run build

# ---------------------------------------------------------------------------

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# `tsx` lives in devDependencies, so the runtime install keeps dev packages. That
# is a deliberate trade for a single-stage TypeScript server: the alternative is
# a separate compile step and a second tsconfig, and the image is still small.
COPY package.json package-lock.json* ./
# --include=dev: NODE_ENV=production above would otherwise make npm skip the
# devDependencies, and the server runs through tsx.
RUN npm ci --include=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server
COPY src ./src
COPY tsconfig.json ./

# Run as the unprivileged user the base image already provides.
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No --port and no --host: the server reads them from the environment, so a
# hosting platform that assigns its own PORT is honoured instead of overridden.
CMD ["npm", "run", "server", "--", "--speed", "4"]
