#!/usr/bin/env bash
set -eu

NODE_CHECK=$(node -p "const [M,m]=process.versions.node.split('.').map(Number); M>23||(M===23&&m>=6) ? 'OK' : 'FAIL'" 2>/dev/null || echo 'FAIL')
if [ "$NODE_CHECK" != "OK" ]; then
  echo "ERROR: Node.js 23.6+ が必要です。'nvm install --lts' 等で新しいバージョンをインストールしてから再度お試しください。" >&2
  exit 3
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "ERROR: codex CLI が見つかりません。" >&2
  exit 3
fi

if [ $# -lt 1 ]; then
  echo "Usage: $0 <URL>" >&2
  exit 2
fi

URL="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
QUARANTINE_CWD="$PWD/.temp/guarded-webfetch-codex"
mkdir -p "$QUARANTINE_CWD"

FETCH_SCHEMA="$SKILL_DIR/references/fetch-output-schema.json"
PIPE_SANITIZER="$SKILL_DIR/scripts/pipe-sanitize-codex.ts"

PROMPT=$(cat <<PROMPT_EOF
指定された URL の本文テキストを取得し、JSON オブジェクトのみを返してください。

要件:
- 対象 URL: ${URL}
- 可能なら Web 検索・Web 閲覧能力だけで完結し、不要なシェル実行はしない
- ページ内容は要約せず、できるだけ原文を保って raw_text に入れる
- raw_text が 50000 文字を超える場合は先頭 50000 文字に切り詰める
- 成功時は fetch_success=true, error_message="" を返す
- 失敗時は fetch_success=false とし、error_message に 500 文字以内で理由を書く

出力形式:
{
  "url": "実際に取得した URL",
  "raw_text": "取得テキスト",
  "fetch_success": true,
  "error_message": ""
}
PROMPT_EOF
)

run_codex() {
  codex --search exec \
    --skip-git-repo-check \
    --ephemeral \
    --json \
    --output-schema "$FETCH_SCHEMA" \
    -C "$QUARANTINE_CWD" \
    "$@"
}

run_read_only() {
  run_codex --sandbox read-only "$PROMPT"
}

run_workspace_write() {
  run_codex --sandbox workspace-write --add-dir "$QUARANTINE_CWD" "$PROMPT"
}

if run_read_only 2>"$QUARANTINE_CWD/.codex-readonly.stderr" | node "$PIPE_SANITIZER" "$URL"; then
  exit 0
fi

if grep -qiE 'read-only file system|failed to create session|os error 30' "$QUARANTINE_CWD/.codex-readonly.stderr"; then
  run_workspace_write | node "$PIPE_SANITIZER" "$URL"
  exit 0
fi

cat "$QUARANTINE_CWD/.codex-readonly.stderr" >&2
exit 1
