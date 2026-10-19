#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PROFILE_DIR="${DSH_WEB_PROFILE_DIR:-${DSH_HOME:-$HOME/.dsh}/profiles/web}"
CORE_DIR="${DSH_CANVAS_CORE_DIR:-$(dirname "$ROOT_DIR")/dsh-canvas}"

# The DSH browser loader consumes this tiny host wrapper. Site/SDK sources are
# served directly from lib/site; there is no compiled canvas frontend copy.
cp "$ROOT_DIR/src/client.js" "$ROOT_DIR/lib/client.js"

sync_package() {
  local source="$1" name="$2" target="$PROFILE_DIR/node_modules/@xindong/$2"
  if [[ ! -f "$source/package.json" ]]; then
    echo "Missing source package: $source" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$target")"
  if [[ ! -e "$target" && ! -L "$target" ]]; then
    ln -s "$source" "$target"
  elif [[ -L "$target" && ! -e "$target" ]]; then
    echo "Broken runtime symlink: $target (repair it before syncing)" >&2
    exit 1
  elif [[ "$(cd "$target" && pwd -P)" != "$(cd "$source" && pwd -P)" ]]; then
    # Mirror only shipped paths. Never edit profile node_modules by hand.
    for path in lib src scripts; do
      if [[ -d "$source/$path" ]]; then
        mkdir -p "$target/$path"
        rsync -a --delete "$source/$path/" "$target/$path/"
      fi
    done
    for path in package.json pnpm-lock.yaml cordis.patch.yml README.md LICENSE; do
      [[ ! -f "$source/$path" ]] || cp "$source/$path" "$target/$path"
    done
  fi
  printf '  %-18s %s\n' "$name" "$target"
}

sync_package "$CORE_DIR" dsh-canvas
sync_package "$ROOT_DIR" dsh-client-canvas
printf 'Synced source → runtime (no build/typecheck).\n'
printf 'Start: bash %s/scripts/start-local.sh\n' "$ROOT_DIR"
