# Hosted image for AI Creator Lab: the read-only demo, the judging copy, or your own studio on a
# server behind the app password (see docker-entrypoint.sh). It always listens on all interfaces
# inside the container, so a writable studio only ever starts with the password in force.
#
# The repository is an npm workspace: the Next.js app is apps/creator and its libraries are under
# packages/. The working directory stays /app (the repository root) so the workflows in
# packages/recipes/workflows and the caption font in assets/ resolve as they do in development.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/recipes/package.json packages/recipes/
COPY packages/executors/package.json packages/executors/
COPY packages/ui/package.json packages/ui/
COPY packages/content-ugc-ad/package.json packages/content-ugc-ad/
COPY apps/creator/package.json apps/creator/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production STUDIO_DATA_DIR=/data
COPY --chown=node:node --from=build /app/package.json /app/package-lock.json ./
# node_modules links the workspace packages (node_modules/@creator-lab/* -> packages/*, apps/*).
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/packages ./packages
COPY --chown=node:node --from=build /app/apps/creator/package.json /app/apps/creator/next.config.ts ./apps/creator/
COPY --chown=node:node --from=build /app/apps/creator/.next ./apps/creator/.next
COPY --chown=node:node --from=build /app/assets ./assets
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
