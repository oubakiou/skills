#!/usr/bin/env bash
# main agent がステップ 0 で呼ぶ事前バージョンチェック専用スクリプト
# quarantine-fetch-gemini.sh 冒頭の自動チェックは多層防御として並存させる
set -euo pipefail

NODE_CHECK=$(node -p "const [M,m]=process.versions.node.split('.').map(Number); (M>23||(M===23&&m>=6)) ? 'OK' : 'FAIL'" 2>/dev/null || echo 'FAIL')
if [ "$NODE_CHECK" != "OK" ]; then
  current=$(node -v 2>/dev/null || echo 'not installed')
  echo "ERROR: Node.js 23.6+ が必要です (現在: $current)。'nvm install --lts' 等で新しいバージョンをインストールしてから再度お試しください。" >&2
  exit 3
fi
echo "OK"
