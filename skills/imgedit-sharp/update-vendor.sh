#!/usr/bin/env bash
set -euo pipefail

# sharp の wasm32 ビルドを scripts/vendor/node_modules/ に取り込み直す開発用スクリプト。
# sharp のバージョンを上げる場合はここを実行して差分をコミットする

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

SHARP_VERSION="${SHARP_VERSION:-latest}"

(cd "$TMP_DIR" && npm install --cpu=wasm32 --no-audit --no-fund "sharp@${SHARP_VERSION}")

# webcontainers 用 wasm32 variant は Node.js 実行では使われないため同梱しない
rm -rf \
  "$TMP_DIR/node_modules/.package-lock.json" \
  "$TMP_DIR/node_modules/@img/sharp-webcontainers-wasm32"

rm -rf "$SKILL_DIR/scripts/vendor/node_modules"
mkdir -p "$SKILL_DIR/scripts/vendor"
cp -R "$TMP_DIR/node_modules" "$SKILL_DIR/scripts/vendor/node_modules"

echo "vendored sharp: $(node -e "console.log(JSON.parse(require('fs').readFileSync('$SKILL_DIR/scripts/vendor/node_modules/sharp/package.json','utf8')).version)")"
echo "注意: devDependencies の sharp (型定義用) も同じバージョンに更新すること"
