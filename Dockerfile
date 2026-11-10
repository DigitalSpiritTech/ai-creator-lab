# Hosted image for AI Creator Lab: the read-only demo, the judging copy, or your own studio on a
# server behind the app password (see docker-entrypoint.sh). It always listens on all interfaces
# inside the container, so a writable studio only ever starts with the password in force.
#
# The repository is an npm workspace: the Next.js app is apps/creator and its libraries are under
# packages/. The working directory stays /app (the repository root) so the workflows in
# packages/recipes/workflows and the caption font in assets/ resolve as they do in development.
#
# ffmpeg and ffprobe in the image are Debian's (apt, bookworm, built with drawtext), whose source
# Debian provides. The image never contains the static binaries a native `npm ci` downloads
# (ffmpeg-static, @derhuerst/ffprobe-static): the build stage installs with --ignore-scripts, so
# those packages download nothing, and FFMPEG_PATH and FFPROBE_PATH point at /usr/bin. No other
# runtime package needs an install script (sharp ships its binaries as optional dependencies).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/recipes/package.json packages/recipes/
COPY packages/executors/package.json packages/executors/
COPY packages/ui/package.json packages/ui/
COPY packages/content-ugc-ad/package.json packages/content-ugc-ad/
COPY packages/content-social-post/package.json packages/content-social-post/
COPY apps/creator/package.json apps/creator/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
# Debian's ffmpeg has drawtext (libfreetype); the captions use the font bundled in assets/fonts.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production STUDIO_DATA_DIR=/data FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe
COPY --chown=node:node --from=build /app/package.json /app/package-lock.json ./
# node_modules links the workspace packages (node_modules/@creator-lab/* -> packages/*, apps/*).
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/packages ./packages
COPY --chown=node:node --from=build /app/apps/creator/package.json /app/apps/creator/next.config.ts ./apps/creator/
COPY --chown=node:node --from=build /app/apps/creator/.next ./apps/creator/.next
COPY --chown=node:node --from=build /app/assets ./assets
# The in-app Gallery reads examples/ from the working directory.
COPY --chown=node:node --from=build /app/examples ./examples
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Fail the build if a static ffmpeg or ffprobe binary ever reaches the image.
RUN test ! -e node_modules/ffmpeg-static/ffmpeg && test ! -e node_modules/@derhuerst/ffprobe-static/ffprobe \
  && chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
