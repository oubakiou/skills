#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: render-svg.sh <spec.json> <output.svg>" >&2
  exit 1
fi

SPEC_FILE="$1"
OUTPUT_FILE="$2"

if [[ ! -f "$SPEC_FILE" ]]; then
  echo "Error: spec file not found: $SPEC_FILE" >&2
  exit 1
fi

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

node "$SKILL_DIR/scripts/vl2svg.mjs" "$SPEC_FILE" "$OUTPUT_FILE"
