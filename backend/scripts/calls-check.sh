#!/usr/bin/env bash
#
# Stands up a throwaway mongod and checks the 3CX call sync and the Calls page
# against it, with a stand-in 3CX (started by the check itself on 127.0.0.1).
# Tears it down after.
#
# Nothing here touches a configured database or the real 3CX: the scratch
# mongod runs on its own port with its own data directory, bun is told not to
# read .env (and DOTENV_CONFIG_PATH points nowhere), THREECX_* name the
# stand-in, and the check refuses to start unless MONGODB_URI names a scratch
# database.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${CALLS_MONGO_PORT:-$((27100 + RANDOM % 800))}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/calls-check.XXXXXX")"

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

if [ "$PORT" = "27017" ] || lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "Port $PORT is not free. Set CALLS_MONGO_PORT." >&2
  exit 1
fi

mkdir -p "$WORK/db" "$WORK/log"
mongod --dbpath "$WORK/db" --port "$PORT" --bind_ip 127.0.0.1 --fork --logpath "$WORK/log/mongod.log" >/dev/null

cd "$REPO"
MONGODB_URI="mongodb://127.0.0.1:$PORT/crm-calls-scratch" DOTENV_CONFIG_PATH=/nonexistent \
  THREECX_URL= THREECX_CLIENT_ID= THREECX_API_KEY= \
  bun --no-env-file run scripts/calls-check.ts
