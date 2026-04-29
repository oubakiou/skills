#!/usr/bin/env bash
# main agent がステップ 0 で呼べる事前バージョンチェック専用スクリプト。
# quarantine-search-codex.sh からも `bash <path>` でサブプロセス呼び出しして使う。
set -euo pipefail

NODE_CHECK=$(node -p "const [M,m]=process.versions.node.split('.').map(Number); M>23||(M===23&&m>=6) ? 'OK' : 'FAIL'" 2>/dev/null || echo 'FAIL')
if [ "$NODE_CHECK" != "OK" ]; then
  current=$(node -v 2>/dev/null || echo 'not installed')
  echo "ERROR: Node.js 23.6+ が必要です (現在: $current)。'nvm install --lts' 等で新しいバージョンをインストールしてから再度お試しください。" >&2
  exit 3
fi
echo "OK"
