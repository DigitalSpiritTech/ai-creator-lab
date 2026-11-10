#!/bin/sh
# Starts a hosted copy: the read-only demo, the judging copy, or your own studio behind the app
# password. Every mode listens on all interfaces inside the container, so a writable studio is
# only ever started with the app password in force (the setup code is printed to the log on the
# first start).
set -e
if [ -z "$STUDIO_PUBLIC_HOST" ]; then
  echo "Set STUDIO_PUBLIC_HOST=<the hostname this copy is served on>." >&2
  exit 1
fi
if [ "$STUDIO_READ_ONLY" = "1" ]; then
  if [ -n "$COMFY_API_KEY" ] || [ -n "$ANTHROPIC_API_KEY" ] || [ -n "$GENERATION_ALLOWANCE_USD" ]; then
    echo "Refusing to start: the read-only demo must run without API keys or an allowance." >&2
    exit 1
  fi
  rm -f "$STUDIO_DATA_DIR/secrets.json"
elif [ -n "$STUDIO_JUDGE_PASSWORD" ] || [ "$STUDIO_JUDGE_OPEN" = "1" ]; then
  if [ -n "$STUDIO_JUDGE_PASSWORD" ] && [ "${#STUDIO_JUDGE_PASSWORD}" -lt 12 ]; then
    echo "STUDIO_JUDGE_PASSWORD must be at least 12 characters." >&2
    exit 1
  fi
  if [ -z "$GENERATION_ALLOWANCE_USD" ]; then
    echo "Judging mode needs GENERATION_ALLOWANCE_USD, the most this copy may ever spend." >&2
    exit 1
  fi
else
  # Your own studio on a server: the app password is required for every page and API call.
  export STUDIO_ALLOWED_HOSTS="${STUDIO_ALLOWED_HOSTS:-$STUDIO_PUBLIC_HOST}"
  echo "Starting the studio with the app password (sign in at https://$STUDIO_PUBLIC_HOST/login)."
fi
export HOST=0.0.0.0
# The Next.js app is apps/creator; the working directory stays the repository root (/app).
exec npx next start apps/creator --hostname 0.0.0.0 --port "${PORT:-3000}"
