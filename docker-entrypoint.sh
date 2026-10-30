#!/bin/sh
# Starts a hosted copy: the read-only demo, or the password-protected judging copy. Refuses to
# listen on all interfaces in any other configuration, so this image cannot expose a writable
# studio by accident.
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
  echo "This image only runs the read-only demo (STUDIO_READ_ONLY=1) or the judging copy (STUDIO_JUDGE_PASSWORD, or STUDIO_JUDGE_OPEN=1 for no password)." >&2
  exit 1
fi
exec npx next start --hostname 0.0.0.0 --port "${PORT:-3000}"
