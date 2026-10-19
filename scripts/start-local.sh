#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
bash "$ROOT_DIR/scripts/sync-runtime.sh"
VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" "$ROOT_DIR/lib/site/dsh.json")"
RUNTIME_DIR="${DSH_CANVAS_RUNTIME_DIR:-${DSH_HOME:-$HOME/.dsh}/canvas-runtimes/$VERSION}"
CLI="$RUNTIME_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
MARKER="$RUNTIME_DIR/.installed-version"

RESTART=false
PORT=3080
HOST=127.0.0.1
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restart) RESTART=true; shift ;;
    --port|--host)
      if [[ $# -lt 2 ]]; then echo "$1 requires a value" >&2; exit 1; fi
      if [[ "$1" == --port ]]; then PORT="$2"; else HOST="$2"; fi
      ARGS+=("$1" "$2"); shift 2 ;;
    --port=*) PORT="${1#*=}"; ARGS+=("$1"); shift ;;
    --host=*) HOST="${1#*=}"; ARGS+=("$1"); shift ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
if [[ ! "$PORT" =~ ^[0-9]+$ || ${#PORT} -gt 5 ]] || (( 10#$PORT > 65535 )); then
  echo "Invalid port: $PORT" >&2; exit 1
fi

# Detect a duplicate before Cordis reports a cascade of missing services.
# Never stop an unrelated port owner. --restart is an explicit opt-in.
if [[ "$PORT" != 0 ]] && command -v lsof >/dev/null 2>&1; then
  LISTENERS="$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u || true)"
  if [[ -n "$LISTENERS" ]]; then
    OWNED=true
    for PID in $LISTENERS; do
      COMMAND="$(ps -p "$PID" -o command= || true)"
      OWNER="$(ps -p "$PID" -o uid= | tr -d ' ' || true)"
      if [[ "$COMMAND" != *"$CLI web"* || "$OWNER" != "$(id -u)" ]]; then OWNED=false; fi
    done
    if [[ "$OWNED" != true ]]; then
      echo "Port $PORT is occupied by another process (PID: $LISTENERS)." >&2
      echo "Not stopping it. Stop that service or use --port <another-port>." >&2
      exit 1
    fi
    if [[ "$RESTART" != true ]]; then
      echo "DSH is already running on port $PORT (PID: $LISTENERS); no duplicate started."
      LOGIN_URL="$(node -e '
        try {
          const fs = require("fs");
          const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          const url = new URL(state.url);
          if (String(state.pid) === process.argv[2] && ["http:", "https:"].includes(url.protocol)) console.log(state.url);
        } catch {}
      ' "$RUNTIME_DIR/web-address.json" "$LISTENERS")"
      if [[ -n "$LOGIN_URL" ]]; then
        echo "Open (authenticated): $LOGIN_URL"
      else
        echo "Use the complete login URL printed by the running DSH (including ?token=...)."
        echo "To generate and remember a new login link, use --restart."
      fi
      echo "Source synced. To reload server changes, run: bash $ROOT_DIR/scripts/start-local.sh --restart"
      exit 0
    fi
    echo "Stopping the existing DSH on port $PORT (PID: $LISTENERS)..."
    for PID in $LISTENERS; do kill -INT "$PID"; done
    for ((attempt=0; attempt<100; attempt++)); do
      REMAINING="$(lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
      [[ -n "$REMAINING" ]] || break
      sleep 0.1
    done
    if [[ -n "$REMAINING" ]]; then
      echo "Port $PORT has not been released; aborting instead of force-killing processes." >&2
      exit 1
    fi
  fi
fi

# A dedicated, versioned installation avoids npm exec's half-installed cache.
# Install lifecycle output must be visible: a failed native prebuilt previously
# left only a spinner and silently tried to compile with unavailable CMake.
if [[ ! -f "$MARKER" || "$(cat "$MARKER")" != "$VERSION" || ! -f "$CLI" ]]; then
  mkdir -p "$RUNTIME_DIR"
  echo "Installing DSH $VERSION into $RUNTIME_DIR (first launch only)."
  echo "Installation output is shown below; npm logs: $RUNTIME_DIR/npm-logs"
  if ! npm install --prefix "$RUNTIME_DIR" --save-exact \
      --no-audit --no-fund --foreground-scripts --progress=false --loglevel=warn \
      --fetch-timeout=30000 --fetch-retries=1 \
      --logs-dir="$RUNTIME_DIR/npm-logs" "@deepseek-ai/dsh@$VERSION"; then
    echo "DSH installation failed; see the error above and $RUNTIME_DIR/npm-logs." >&2
    exit 1
  fi
  printf '%s\n' "$VERSION" > "$MARKER"
fi

node "$ROOT_DIR/scripts/setup-preview-runtime.mjs"
echo "Starting DSH $VERSION + upstream PixiBoard site."
echo "Runtime: $RUNTIME_DIR (reused; no npm download on subsequent starts)."
exec node "$ROOT_DIR/scripts/start-runtime.mjs" "$CLI" "$RUNTIME_DIR" ${ARGS[@]+"${ARGS[@]}"}
