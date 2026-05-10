#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

# Node.js のバージョンチェックは check-node-version.sh に集約。
# bash サブプロセス呼び出しで exit 3 を伝播させ、quarantine 側の前提条件不足判定と一本化する。
bash "$SCRIPT_DIR/check-node-version.sh" >/dev/null

if ! command -v codex >/dev/null 2>&1; then
  echo "ERROR: codex CLI が見つかりません。" >&2
  exit 3
fi

if [ $# -lt 1 ] || [ -z "${1:-}" ]; then
  echo "Usage: $0 <URL>" >&2
  exit 2
fi

URL="$1"

# 入口で URL を検証して、不正な URL のまま高コストな codex 子プロセスを起動するのを防ぐ
# (pipe-sanitize-codex.ts 側にも同等の検証はあるが、API コスト発生前に弾くことが重要)
case "$URL" in
  http://*|https://*) ;;
  *)
    echo "ERROR: URL must start with http:// or https:// (got: ${URL})" >&2
    exit 2
    ;;
esac

# バッククォート / $() はヒアドキュメント (sigil 無し) でシェル展開されうるため拒否
# シングルクォートは URL の path/query で合法かつシェル展開の対象でもないため許容する
case "$URL" in
  *'`'*|*'$('*)
    echo "ERROR: URL must not contain backtick or \$()" >&2
    exit 2
    ;;
esac

# 制御文字 (改行・タブを含む) はプロンプト整形を崩す
if [[ "$URL" =~ [[:cntrl:]] ]]; then
  echo "ERROR: URL must not contain control characters" >&2
  exit 2
fi

# 長大 URL で codex 子を起動して API コストを消費する経路を塞ぐ。
# HTTP/1.1 慣習・主要ブラウザの実用上限・サーバの一般的な上限を踏まえ 2048 字を上限とする。
if [ "${#URL}" -gt 2048 ]; then
  echo "ERROR: URL too long (${#URL} chars, max 2048)" >&2
  exit 2
fi

# 隔離プロセスの cwd を実行ごとに mktemp で run-* サブディレクトリに切り、
# trap EXIT で削除する。並列起動や前回実行の残留ファイル混入を避けるため。
QUARANTINE_BASE="$PWD/.temp/guarded-webfetch-codex"
mkdir -p "$QUARANTINE_BASE"
QUARANTINE_CWD="$(mktemp -d "$QUARANTINE_BASE/run-XXXXXXXX")"
trap 'rm -rf "$QUARANTINE_CWD"' EXIT

FETCH_SCHEMA="$SKILL_DIR/references/fetch-output-schema.json"
PIPE_SANITIZER="$SKILL_DIR/scripts/pipe-sanitize-codex.ts"

# ---------- モデル設定 ----------
# CODEX_MODEL が未設定の場合は gpt-5.4-mini を使用
# (fetch + 要約用途における応答速度とコストのバランスを考慮。新モデル登場時は差し替える)
CODEX_MODEL="${CODEX_MODEL:-gpt-5.4-mini}"

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
    -m "$CODEX_MODEL" \
    --skip-git-repo-check \
    --ephemeral \
    --ignore-user-config \
    --ignore-rules \
    --json \
    --output-schema "$FETCH_SCHEMA" \
    -C "$QUARANTINE_CWD" \
    "$@"
}

run_read_only() {
  run_codex --sandbox read-only "$PROMPT"
}

if run_read_only 2>"$QUARANTINE_CWD/.codex-readonly.stderr" | node "$PIPE_SANITIZER" "$URL"; then
  exit 0
fi

cat "$QUARANTINE_CWD/.codex-readonly.stderr" >&2
exit 1
