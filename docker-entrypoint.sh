#!/bin/sh
# Starts the read-only demo. Refuses to listen on all interfaces unless read-only mode and a
# public host are set, so this image cannot accidentally expose a writable studio.
set -e
if [ "$STUDIO_READ_ONLY" != "1" ] || [ -z "$STUDIO_PUBLIC_HOST" ]; then
  echo "This image only runs the read-only demo. Set STUDIO_READ_ONLY=1 and STUDIO_PUBLIC_HOST=<your demo hostname>." >&2
  exit 1
fi
if [ -n "$COMFY_API_KEY" ] || [ -n "$ANTHROPIC_API_KEY" ] || [ -n "$GENERATION_ALLOWANCE_USD" ]; then
  echo "Refusing to start: the demo must run without API keys or an allowance." >&2
  exit 1
fi
rm -f "$STUDIO_DATA_DIR/secrets.json"
exec npx next start --hostname 0.0.0.0 --port "${PORT:-3000}"
