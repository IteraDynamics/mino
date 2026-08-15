# syntax=docker/dockerfile:1.7

FROM node:22.23.2-bookworm-slim AS build
WORKDIR /app

ENV NODE_ENV=development

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

# Prisma loads prisma.config.ts during client generation. This command-scoped
# localhost value is intentionally non-secret and never reaches a runtime image.
RUN DATABASE_URL=postgresql://mino:build-only@127.0.0.1:5432/mino \
    npm run prisma:generate \
 && npm run build

FROM build AS production-deps
# npm peer/dependency resolution may retain the Prisma CLI package after a
# production prune. The long-running runtime has no schema-management authority,
# so remove the CLI and its executable explicitly after pruning. Generated
# Prisma client/runtime dependencies remain intact.
RUN npm prune --omit=dev \
 && rm -rf node_modules/prisma node_modules/.bin/prisma

FROM node:22.23.2-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    MINO_HOST=0.0.0.0 \
    MINO_PORT=3000

RUN groupadd --system --gid 10001 mino \
 && useradd --system --uid 10001 --gid mino --home-dir /app --shell /usr/sbin/nologin mino

COPY --from=production-deps --chown=mino:mino /app/package.json /app/package-lock.json ./
COPY --from=production-deps --chown=mino:mino /app/node_modules ./node_modules
COPY --from=build --chown=mino:mino /app/dist ./dist

USER 10001:10001
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MINO_PORT||'3000')+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]

# Short-lived schema-management image. It deliberately retains the Prisma CLI,
# migration history, and OpenSSL support, while the long-running runtime image does not.
FROM node:22.23.2-bookworm-slim AS migration
WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 mino \
 && useradd --system --uid 10001 --gid mino --home-dir /app --shell /usr/sbin/nologin mino

COPY --from=build --chown=mino:mino /app/package.json /app/package-lock.json ./
COPY --from=build --chown=mino:mino /app/node_modules ./node_modules
COPY --from=build --chown=mino:mino /app/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=mino:mino /app/prisma ./prisma

USER 10001:10001
CMD ["npm", "run", "prisma:migrate:deploy"]
