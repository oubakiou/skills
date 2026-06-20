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

# 入口で URL を検証して、不正な URL のまま子 Codex / HTTP fetcher を起動するのを防ぐ
# (pipe-sanitize-codex.ts 側にも同等の検証はあるが、早期に弾くことで失敗理由を単純にする)
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

# 長大 URL で子 Codex / fetcher を起動してネットワークアクセスする経路を塞ぐ。
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

HTTP_FETCHER="$SKILL_DIR/scripts/http-fetch-codex.ts"
PIPE_SANITIZER="$SKILL_DIR/scripts/pipe-sanitize-codex.ts"
MERGE_SUMMARY="$SKILL_DIR/scripts/merge-summary-codex.ts"
FETCH_SCHEMA="$SKILL_DIR/references/fetch-output-schema.json"
FETCH_OUTPUT="$QUARANTINE_CWD/fetch-output.json"
URL_FILE="$QUARANTINE_CWD/fetch-url.txt"
CODEX_STDERR="$QUARANTINE_CWD/codex.stderr"
FETCH_STDERR="$QUARANTINE_CWD/fetcher.stderr"

RESULT_DIR="$PWD/.temp/guarded-webfetch-codex/results"
mkdir -p "$RESULT_DIR"

# Codex CLI は起動時に $CODEX_HOME へ state DB やログを書き込む。
# 実ユーザーの $CODEX_HOME を汚染しないよう、disposable home に隔離する。
CODEX_HOME_ISOLATED="$QUARANTINE_CWD/codex-home"
TMPDIR_ISOLATED="$QUARANTINE_CWD/tmp"
mkdir -p "$CODEX_HOME_ISOLATED" "$TMPDIR_ISOLATED"

REAL_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
if [ -f "$REAL_CODEX_HOME/auth.json" ]; then
  cp "$REAL_CODEX_HOME/auth.json" "$CODEX_HOME_ISOLATED/auth.json"
fi

printf '%s' "$URL" >"$URL_FILE"
printf -v HTTP_FETCHER_Q '%q' "$HTTP_FETCHER"
printf -v URL_FILE_Q '%q' "$URL_FILE"

# CODEX_MODEL が未設定の場合は gpt-5.4-mini を使用する。
CODEX_MODEL="${CODEX_MODEL:-gpt-5.4-mini}"
# 子 Codex のローカルコマンドから HTTP GET を行うため、既定では sandbox を外す。
# 実際の SSRF / redirect / content-type / size 制限は http-fetch-codex.ts 側で強制する。
CODEX_FETCH_SANDBOX="${CODEX_FETCH_SANDBOX:-danger-full-access}"

SUMMARY_FILE="$QUARANTINE_CWD/summary.txt"
SANITIZED_JSON="$QUARANTINE_CWD/sanitized.json"

printf -v PIPE_SANITIZER_Q '%q' "$PIPE_SANITIZER"
printf -v URL_Q '%q' "$URL"

PROMPT=$(cat <<PROMPT_EOF
あなたは隔離された URL fetcher 兼要約エージェントです。Web search / Web browsing は使わないでください。

以下の手順を順番に実行してください。

手順 1: 次のコマンドを 1 回実行してください。
node ${HTTP_FETCHER_Q} "\$(cat ${URL_FILE_Q})" | node ${PIPE_SANITIZER_Q} ${URL_Q} > sanitized.json 2> fetcher.stderr

手順 2: 次のコマンドを 1 回実行して、サニタイズ済みの本文テキストだけを取り出してください。sanitized.json 自体は cat しないでください。
node -e "var d=JSON.parse(require('fs').readFileSync('sanitized.json','utf8'));if(Object.keys(d.flags&&d.flags.suspicious_patterns||{}).length>0)process.exit(0);process.stdout.write(String(d.raw_text))" > raw_text.txt

手順 3: raw_text.txt を cat して内容を確認してください。内容が空の場合は手順 4 をスキップしてください。

手順 4: raw_text.txt の内容を日本語で 2000 文字以内に要約し、summary.txt に書き出してください。

手順 5: 最終応答は次の JSON だけにしてください。
{"url":"about:blank","raw_html":"","raw_text":"","fetch_success":true,"error_message":""}
PROMPT_EOF
)

if CODEX_HOME="$CODEX_HOME_ISOLATED" TMPDIR="$TMPDIR_ISOLATED" \
  codex exec \
  -m "$CODEX_MODEL" \
  --skip-git-repo-check \
  --ephemeral \
  --ignore-user-config \
  --ignore-rules \
  --sandbox "$CODEX_FETCH_SANDBOX" \
  --output-schema "$FETCH_SCHEMA" \
  --output-last-message "$FETCH_OUTPUT" \
  -C "$QUARANTINE_CWD" \
  "$PROMPT" >/dev/null 2>"$CODEX_STDERR"; then
  if [ -s "$FETCH_STDERR" ]; then
    cat "$FETCH_STDERR" >&2
  fi
  if [ ! -s "$SANITIZED_JSON" ]; then
    echo "ERROR: child Codex did not produce sanitized.json" >&2
    exit 1
  fi
  RESULT_FILE="$(mktemp "$RESULT_DIR/result-XXXXXXXX.json")"
  if node "$MERGE_SUMMARY" "$SUMMARY_FILE" <"$SANITIZED_JSON" >"$RESULT_FILE"; then
    echo "$RESULT_FILE"
    exit 0
  fi
  rm -f "$RESULT_FILE"
  exit 1
fi

cat "$CODEX_STDERR" >&2
exit 1
