# syntax=docker/dockerfile:1.7

FROM node:22.23.2-bookworm-slim AS build
WORKDIR /app

ENV NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

RUN npm run prisma:generate \
 && npm run build \
 && npm prune --omit=dev

FROM node:22.23.2-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    MINO_HOST=0.0.0.0 \
    MINO_PORT=3000

RUN groupadd --system --gid 10001 mino \
 && useradd --system --uid 10001 --gid mino --home-dir /app --shell /usr/sbin/nologin mino

COPY --from=build --chown=mino:mino /app/package.json /app/package-lock.json ./
COPY --from=build --chown=mino:mino /app/node_modules ./node_modules
COPY --from=build --chown=mino:mino /app/dist ./dist

USER 10001:10001
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MINO_PORT||'3000')+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
