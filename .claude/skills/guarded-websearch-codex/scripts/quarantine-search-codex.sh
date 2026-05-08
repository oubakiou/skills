#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

# Node.js のバージョンチェックは check-node-version.sh に集約。
# bash サブプロセス呼び出しで exit 3 を伝播させ、quarantine 側の前提条件不足判定と一本化する。
"$SCRIPT_DIR/check-node-version.sh" >/dev/null

if ! command -v codex >/dev/null 2>&1; then
  echo "ERROR: codex CLI が見つかりません。" >&2
  exit 3
fi

if [ $# -lt 1 ] || [ -z "${1:-}" ]; then
  echo "Usage: $0 <QUERY>" >&2
  exit 2
fi

QUERY="$1"

# 入口でクエリを検証して、不正なクエリのまま高コストな codex 子プロセスを起動するのを防ぐ
# (pipe-sanitize-search-codex.ts 側にも同等の検証はあるが、API コスト発生前に弾くことが重要)

# バッククォート / $() はヒアドキュメント (sigil 無し) でシェル展開されうるため拒否
# bash 仕様上、変数値の中身が再評価されることはないが、プロンプト整形の崩れや
# 将来の実装変更で injection 経路になる余地を一律塞ぐため fail-closed とする
case "$QUERY" in
  *'`'*|*'$('*)
    echo "ERROR: QUERY must not contain backtick or \$()" >&2
    exit 2
    ;;
esac

# 制御文字 (改行・タブを含む) はプロンプト整形を崩す
if [[ "$QUERY" =~ [[:cntrl:]] ]]; then
  echo "ERROR: QUERY must not contain control characters" >&2
  exit 2
fi

# 長大クエリで codex 子を起動して API コストを消費する経路を塞ぐ。
# pipe-sanitize-search-codex.ts 側の検証 (1000 字) と同じ上限を bash 側にも置く
if [ "${#QUERY}" -gt 1000 ]; then
  echo "ERROR: QUERY too long (${#QUERY} chars, max 1000)" >&2
  exit 2
fi

# 隔離プロセスの cwd を実行ごとに mktemp で run-* サブディレクトリに切り、
# trap EXIT で削除する。並列起動や前回実行の残留ファイル混入を避けるため。
QUARANTINE_BASE="$PWD/.temp/guarded-websearch-codex"
mkdir -p "$QUARANTINE_BASE"
QUARANTINE_CWD="$(mktemp -d "$QUARANTINE_BASE/run-XXXXXXXX")"
trap 'rm -rf "$QUARANTINE_CWD"' EXIT

SEARCH_SCHEMA="$SKILL_DIR/references/search-output-schema.json"
PIPE_SANITIZER="$SKILL_DIR/scripts/pipe-sanitize-search-codex.ts"

# ---------- モデル設定 ----------
# CODEX_MODEL が未設定の場合は gpt-5.4-mini を使用
# (search 結果の整形における応答速度とコストのバランスを考慮。新モデル登場時は差し替える)
CODEX_MODEL="${CODEX_MODEL:-gpt-5.4-mini}"

PROMPT=$(cat <<PROMPT_EOF
指定された検索クエリで Web 検索を実行し、結果を JSON オブジェクトのみで返してください。

要件:
- 検索クエリ: ${QUERY}
- 可能なら Web 検索・Web 閲覧能力だけで完結し、不要なシェル実行はしない
- 最大 10 件の検索結果を返す
- 各結果には url, title, snippet を含める
- title と snippet は加工しすぎず、検索結果表示に近い内容を保つ
- 成功時は search_success=true, error_message="" を返す
- 失敗時は search_success=false とし、error_message に 500 文字以内で理由を書く

出力形式:
{
  "query": "実行した検索クエリ",
  "results": [
    {
      "url": "結果URL",
      "title": "タイトル",
      "snippet": "スニペット"
    }
  ],
  "search_success": true,
  "error_message": ""
}
PROMPT_EOF
)

run_codex() {
  codex --search exec \
    -m "$CODEX_MODEL" \
    --skip-git-repo-check \
    --ephemeral \
    --json \
    --output-schema "$SEARCH_SCHEMA" \
    -C "$QUARANTINE_CWD" \
    "$@"
}

run_read_only() {
  run_codex --sandbox read-only "$PROMPT"
}

run_workspace_write() {
  run_codex --sandbox workspace-write --add-dir "$QUARANTINE_CWD" "$PROMPT"
}

if run_read_only 2>"$QUARANTINE_CWD/.codex-readonly.stderr" | node "$PIPE_SANITIZER" "$QUERY"; then
  exit 0
fi

# EROFS (Linux errno 30) 起因の sandbox 失敗だけに絞る。
# 'failed to create session' のような session 周りの汎用文言は認証・ネットワーク・
# 内部障害でも出うるため、それで workspace-write に昇格させると不要な権限拡大になる。
# Codex は Rust 製で、read-only fs への書き込み失敗は std::io::Error 経由で
# 必ず "Read-only file system" か "(os error 30)" を含むエラー文を吐くため、この 2 つで十分捕捉できる。
if grep -qiE 'read-only file system|os error 30' "$QUARANTINE_CWD/.codex-readonly.stderr"; then
  run_workspace_write | node "$PIPE_SANITIZER" "$QUERY"
  exit 0
fi

cat "$QUARANTINE_CWD/.codex-readonly.stderr" >&2
exit 1
