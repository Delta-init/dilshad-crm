#!/usr/bin/env bash
#
# Stands up a throwaway mongod and checks the commission rules against it,
# with a stand-in for finance. Tears it down after.
#
# Nothing here touches a configured database or finance: the scratch mongod runs
# on its own port with its own data directory, bun is told not to read .env, and
# the check refuses to start unless MONGODB_URI names a scratch database.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${COLLECTED_MONGO_PORT:-27086}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/collected-commission-check.XXXXXX")"

cleanup() {
  local code=$?
  # Some mongod builds have no --shutdown; stop it by its port instead.
  local pid
  pid="$(lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    kill $pid 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 $pid 2>/dev/null || break; sleep 0.2; done
  fi
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

if lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Set COLLECTED_MONGO_PORT." >&2
  exit 1
fi

mkdir -p "$WORK/db" "$WORK/log"
mongod --dbpath "$WORK/db" --port "$PORT" --bind_ip 127.0.0.1 --fork --logpath "$WORK/log/mongod.log" >/dev/null

cd "$REPO"
MONGODB_URI="mongodb://127.0.0.1:$PORT/crm-scratch" DOTENV_CONFIG_PATH=/nonexistent \
  bun --no-env-file run scripts/collected-commission-check.ts
