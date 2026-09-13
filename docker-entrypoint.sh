#!/bin/sh
set -eu
# Keep runtime-owned media paths writable without running the app as root.
if [ "${OBJECT_STORAGE_PROVIDER:-local}" = "local" ]; then
  media_path="${OBJECT_STORAGE_LOCAL_PATH:-/data/media}"
  mkdir -p "$media_path"
  chown -R node:node "$media_path"
fi
exec su-exec node "$@"
