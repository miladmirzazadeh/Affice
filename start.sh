#!/usr/bin/env bash
# Development: the office server (tsx watch, port AFFICE_PORT, default 4747) and the Vite client (5190,
# which proxies /api and /ws to the server). npm run dev:all runs this. Trella needs no terminal of its own:
# Affice starts the Trella service of the open project and stops it again.
#
# To run Affice the way a user does (one port, the built client), use npm run build and then npm start, or
# npx affice from the npm package.
#
# A port that is already listening is left alone. Ctrl+C or TERM stops only what this run started.
# The pid lists are word-split on purpose.
# shellcheck disable=SC2086
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
CLIENT_PORT=5190
AFFICE_PORT="${AFFICE_PORT:-4747}"
export AFFICE_PORT
# The office server trusts the Vite page (and only it) besides its own origin; see vite.config.ts.
AFFICE_DEV_ORIGIN="http://localhost:$CLIENT_PORT"
export AFFICE_DEV_ORIGIN

OPEN=1
for arg in "$@"; do
  case "$arg" in
    --no-open) OPEN=0 ;;
    -h|--help)
      cat <<USAGE
Usage: ./start.sh [--no-open] [--help]

Starts the office server (port $AFFICE_PORT) and the office client (port $CLIENT_PORT) for development.
A port that is already listening is left alone. Ctrl+C stops what this run started.

  --no-open   do not open the client in the browser
  --help      show this help

Environment: AFFICE_PORT (the office server, default 4747; the Vite proxy follows it), AFFICE_PROJECT (a
project to open at start; without it the browser asks), AFFICE_HOME, AFFICE_TRELLA_PORT, AFFICE_TRELLA_CLI
USAGE
      exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

PIDS=""
STARTED_PORTS=""
CLEANED=0

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# The descendants of a pid, children before parents, so the whole tree can be signalled.
descendants() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do
    descendants "$child"
    echo "$child"
  done
}

# True when the pid exists and is not a zombie.
alive() {
  local state
  state="$(ps -o stat= -p "$1" 2>/dev/null)"
  [ -n "$state" ] && [ "${state#Z}" = "$state" ]
}

# Runs a command in a directory, with its output prefixed by [label].
run_bg() {
  local label="$1" dir="$2"
  shift 2
  (cd "$dir" && exec "$@") > >(sed -u "s/^/[$label] /") 2>&1 &
  PIDS="$PIDS $!"
}

stop_started() {
  [ "$CLEANED" = 1 ] && return
  CLEANED=1
  [ -z "$PIDS" ] && return
  local all="" pid port i left
  for pid in $PIDS; do
    all="$all $(descendants "$pid") $pid"
  done
  echo ""
  echo "Stopping what this run started..."
  for pid in $all; do kill -TERM "$pid" 2>/dev/null; done
  for i in $(seq 1 100); do
    left=0
    for pid in $all; do alive "$pid" && left=1; done
    [ "$left" = 0 ] && break
    sleep 0.1
  done
  for pid in $all; do
    alive "$pid" && kill -KILL "$pid" 2>/dev/null
  done
  for port in $STARTED_PORTS; do
    port_busy "$port" && echo "warning: port $port is still listening" >&2
  done
  echo "Stopped."
}

trap stop_started EXIT
trap 'exit 0' INT TERM

if [ ! -d "$HERE/node_modules" ]; then
  echo "node_modules is missing: running npm install in $HERE"
  (cd "$HERE" && npm install) || { echo "npm install failed" >&2; exit 1; }
fi

if port_busy "$AFFICE_PORT"; then
  echo "[server] already running on $AFFICE_PORT (it must have been started with AFFICE_DEV_ORIGIN=$AFFICE_DEV_ORIGIN, or the page is refused)"
else
  run_bg server "$HERE" npm run server
  STARTED_PORTS="$STARTED_PORTS $AFFICE_PORT"
fi

if port_busy "$CLIENT_PORT"; then
  echo "[client] already running on $CLIENT_PORT"
else
  run_bg client "$HERE" npm run dev
  STARTED_PORTS="$STARTED_PORTS $CLIENT_PORT"
fi

if [ -z "$PIDS" ]; then
  echo "The office server and the office client are both already running. Nothing started."
  exit 0
fi

ready=0
for i in $(seq 1 30); do
  if curl -s -o /dev/null --max-time 2 "http://localhost:$CLIENT_PORT/"; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" = 1 ]; then
  if [ "$OPEN" = 1 ]; then open "http://localhost:$CLIENT_PORT"; fi
else
  echo "The client did not answer on http://localhost:$CLIENT_PORT within 30 s. See the [client] lines above." >&2
fi

echo ""
echo "Office server: http://127.0.0.1:$AFFICE_PORT"
echo "Office client: http://localhost:$CLIENT_PORT"
echo "Ctrl+C stops what this run started."

for pid in $PIDS; do
  wait "$pid"
done
