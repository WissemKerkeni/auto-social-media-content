# tn-core: deterministic content service (image checks, hashing, S3, gates, state machine).
# Build context is the repository root (see docker-compose.yml).
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# --ignore-scripts: no install hooks from dependencies; the Prisma client is generated explicitly.
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npx prisma generate \
 && npm cache clean --force

COPY scripts/lib ./scripts/lib
COPY src ./src
COPY prompts ./prompts

USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/core/main.ts"]
