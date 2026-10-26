# syntax=docker/dockerfile:1
# Uiable - self-hosted server dashboard. Multi-arch: builds natively on amd64, arm64, armv7, ...
# (node-pty is compiled from source for whatever platform the image is built on).

FROM node:26-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json BUILD_INFO.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:26-bookworm-slim
# util-linux: nsenter. procps: fallback ps. tar: folder downloads.
RUN apt-get update \
 && apt-get install -y --no-install-recommends util-linux procps tar ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    UIABLE_DATA_DIR=/data \
    UIABLE_HOST_MODE=nsenter \
    UIABLE_HOST_ROOT=/host \
    UIABLE_BIND=127.0.0.1 \
    UIABLE_PORT=8080 \
    NODE_OPTIONS="--max-old-space-size=96 --max-semi-space-size=2"
VOLUME ["/data"]
EXPOSE 8080

# Infrequent on purpose: each check starts a short-lived node process.
HEALTHCHECK --interval=10m --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "const b=process.env.UIABLE_BIND;const h=(!b||b==='0.0.0.0'||b==='::')?'127.0.0.1':b;require('http').get({host:h,port:process.env.UIABLE_PORT||8080,path:'/api/state'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
