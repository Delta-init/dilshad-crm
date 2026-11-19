#!/usr/bin/env bash
#
# The mentor's meeting on a close (2026-11-18): the held meetings a close offers, the
# close's answer checked and kept, Root asked with it for the mentor's fee. Against a
# stand-in LMS and a stand-in Root the check starts, on a throwaway mongod. Nothing
# configured is touched.
#
#   ./scripts/mentor-meeting-check.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MEETING_MONGO_PORT:-27261}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mentor-meeting-check.XXXXXX")"

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
  echo "Port $PORT is already in use. Set MEETING_MONGO_PORT." >&2
  exit 1
fi

mkdir -p "$WORK/db" "$WORK/log"
mongod --dbpath "$WORK/db" --port "$PORT" --bind_ip 127.0.0.1 --fork --logpath "$WORK/log/mongod.log" >/dev/null

cd "$REPO"
MONGODB_URI="mongodb://127.0.0.1:$PORT/crm-scratch" DOTENV_CONFIG_PATH=/nonexistent \
  bun --no-env-file run scripts/mentor-meeting-check.ts
