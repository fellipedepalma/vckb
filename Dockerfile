# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# The web UI is built here (Vite, devDependencies) and served by the server from dist/web.
COPY web ./web
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
# VCKB_HOST must be 0.0.0.0 inside the container, or the published port can't reach the server.
# Exposure on the host is decided by the port mapping in docker-compose.yml (127.0.0.1 by default).
ENV NODE_ENV=production \
    VCKB_HOST=0.0.0.0 \
    VCKB_PORT=8787 \
    VCKB_BOARDS_DIR=/data \
    VCKB_IN_CONTAINER=1
WORKDIR /app
# App files stay owned by root (read-only for the runtime user); only /data is writable.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY bin ./bin
RUN mkdir -p /data && chown 1000:1000 /data
# Unprivileged "node" user of the base image, by number (uid/gid 1000). docker-compose.yml can
# override it to match the owner of the boards directory on the host.
USER 1000:1000
VOLUME /data
EXPOSE 8787
CMD ["node", "dist/server/index.js"]
