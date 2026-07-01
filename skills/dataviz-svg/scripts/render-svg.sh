#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: render-svg.sh <spec.json> <output.svg> [output.png]" >&2
  exit 1
fi

SPEC_FILE="$1"
OUTPUT_FILE="$2"
PNG_OUTPUT_FILE="${3:-}"

if [[ ! -f "$SPEC_FILE" ]]; then
  echo "Error: spec file not found: $SPEC_FILE" >&2
  exit 1
fi

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -n "$PNG_OUTPUT_FILE" ]]; then
  node "$SKILL_DIR/scripts/vl2svg.mjs" "$SPEC_FILE" "$OUTPUT_FILE" "$PNG_OUTPUT_FILE"
else
  node "$SKILL_DIR/scripts/vl2svg.mjs" "$SPEC_FILE" "$OUTPUT_FILE"
fi
