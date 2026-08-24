FROM oven/bun:1.3-alpine

WORKDIR /app

# Dependency layer (cached until lockfile changes)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Source layer — Bun executes TS directly; no build step by design (ADR 0001)
COPY src ./src
COPY tsconfig.json ./

ENV NODE_ENV=production
USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["bun", "src/index.ts"]
