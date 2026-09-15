FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 falls back to a source build when no prebuilt binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg does every bit of the media work; fonts-noto-cjk renders Japanese captions.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg fonts-noto-cjk ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# npm workspaces hoist dependencies to the root, but a workspace can still keep
# its own node_modules, so the whole server directory is copied as one unit.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server ./server

ENV DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000 1935
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
