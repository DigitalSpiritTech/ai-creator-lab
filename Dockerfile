# Read-only demo image for AI Creator Lab. It serves an existing data folder for viewing only and
# refuses to start any other way (see docker-entrypoint.sh). Not for running the studio itself:
# the studio is meant for your own computer, where it listens on 127.0.0.1 only.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production STUDIO_DATA_DIR=/data STUDIO_RECOVERY=off
COPY --chown=node:node --from=build /app/package.json /app/package-lock.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/.next ./.next
COPY --chown=node:node --from=build /app/assets ./assets
COPY --chown=node:node --from=build /app/workflows ./workflows
COPY --chown=node:node --from=build /app/next.config.ts ./
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
