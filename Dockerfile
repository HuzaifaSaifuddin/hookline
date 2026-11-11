# Hookline: single-process image (API + WebSocket + static web app).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build && npm run typecheck && npx vitest run

FROM node:22-slim
ENV NODE_ENV=production PORT=8787 HOOKLINE_DB=/data/hookline.db
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "--disable-warning=ExperimentalWarning", "apps/server/src/index.ts"]
