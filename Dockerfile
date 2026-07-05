# ─── Build stage ─────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Runtime stage ───────────────────────────────────────────
FROM node:22-bookworm-slim
ENV NODE_ENV=production

# dumb-init for correct signal handling (graceful shutdown). No chromium/puppeteer
# here — the orchestrator talks to whatsapp_manager over HTTP (D3), it does not
# run a WhatsApp client of its own.
RUN apt-get update && apt-get install -y --no-install-recommends \
      dumb-init \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

EXPOSE 3100
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
