#!/usr/bin/env bash
set -euo pipefail

# Node.js 23.6+ を要求する (TypeScript を追加ツールなしで直接実行するため)
REQUIRED_MAJOR=23
REQUIRED_MINOR=6

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node command not found" >&2
  exit 3
fi

NODE_VERSION="$(node --version)"
NODE_MAJOR="$(echo "${NODE_VERSION#v}" | cut -d. -f1)"
NODE_MINOR="$(echo "${NODE_VERSION#v}" | cut -d. -f2)"

if ((NODE_MAJOR < REQUIRED_MAJOR)) || ((NODE_MAJOR == REQUIRED_MAJOR && NODE_MINOR < REQUIRED_MINOR)); then
  echo "Error: Node.js >= ${REQUIRED_MAJOR}.${REQUIRED_MINOR} is required (現在: ${NODE_VERSION})" >&2
  exit 3
fi

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: edit-image.sh <spec.json> | edit-image.sh --info <image>" >&2
  exit 2
fi

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
node "$SKILL_DIR/scripts/edit-image.ts" "$@"
