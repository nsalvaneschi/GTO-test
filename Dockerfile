# Stage 1: build the WASM solver and the web app (Rust + Node)
FROM rust:1-slim AS web
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown \
    && cargo install wasm-bindgen-cli --version 0.2.130 --locked
WORKDIR /src
COPY engine/ ./engine/
COPY web/ ./web/
WORKDIR /src/web
RUN npm ci && npm run build:wasm && npm run build

# Stage 2: runtime (no native deps; node:sqlite + node:crypto)
FROM node:22-slim
WORKDIR /app
COPY server/ ./server/
COPY --from=web /src/web/dist ./web/dist
ENV NODE_ENV=production WEB_DIST=/app/web/dist
CMD ["node", "server/src/index.js"]
