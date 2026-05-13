# guarded-websearch-codex 設計計画

このドキュメントは `guarded-websearch-codex` skill の設計意図・構成・割り切りを記録するためのものである。skill の `references/design-plan.md` として配置し、将来の改修・監査・比較検討時の参照資料とする。

## 目次

1. [スキルの目的](#1-スキルの目的)
2. [guarded-webfetch-codex との関係](#2-guarded-webfetch-codex-との関係)
3. [脅威モデル](#3-脅威モデル)
4. [トリガー条件](#4-トリガー条件)
5. [動作環境と制約](#5-動作環境と制約)
6. [ディレクトリ構成](#6-ディレクトリ構成)
7. [実行フロー](#7-実行フロー)
8. [サニタイザの処理](#8-サニタイザの処理)
9. [隔離プロセス仕様](#9-隔離プロセス仕様)
10. [テストケース](#10-テストケース)
11. [設計上の割り切り](#11-設計上の割り切り)
12. [将来的な拡張候補](#12-将来的な拡張候補)
13. [参考資料](#13-参考資料)

## 1. スキルの目的

Web 検索結果を Claude 親エージェントが扱う際、Codex 子プロセスを隔離 searcher として使用し、検索結果の title・snippet に含まれるプロンプトインジェクション攻撃の影響を抑制するためのガード層を提供する。

guarded-webfetch-codex が個別 URL のコンテンツ取得を対象とするのに対し、本スキルは **検索クエリの実行と検索結果一覧の安全な取得** に特化する。

設計の核は guarded-webfetch-codex と同様、**「untrusted content と特権的判断・ツール実行の論理的分離」** である。Codex 子が検索結果を返し、その出力を静的サニタイザに通した結果だけを親 Claude に渡す。

## 2. guarded-webfetch-codex との関係

### 分離の理由

1. Web 検索と個別ページ取得では出力構造が異なる
2. 検索結果は複数件の `url/title/snippet` 配列であり、個別ページ本文よりサニタイズ単位が細かい
3. URL 候補選定と個別ページ取得では親 Claude の判断ポイントが異なる

### 典型的な連携フロー

```text
ユーザー: 「○○について調べて」
  ↓
guarded-websearch-codex: 検索 → サニタイズ済み検索結果
  ↓
main Claude: 関連 URL を選定
  ↓
guarded-webfetch-codex: 個別 URL を取得
  ↓
main Claude: 最終応答を生成
```

## 3. 脅威モデル

想定する攻撃:

- 検索結果の title/snippet への LLM マーカー埋め込み
- 不可視 Unicode 攻撃
- `ignore previous instructions` 等の上書きパターン混入
- `javascript:` など unsafe scheme の URL 混入
- Codex 子の最終 JSON メッセージ偽装
- 親が検索結果の title/snippet を過度に信頼することによる誘導

想定しない攻撃:

- 検索エンジン自体のランキングや品質問題
- 個別ページ本文に含まれる攻撃
- 自然言語だけで巧妙に誘導するソーシャルエンジニアリング

## 4. トリガー条件

以下のいずれかに該当するとき発火させる。

- ユーザーが「○○について調べて」「○○を検索して」等の Web 検索要求をした
- Claude 親のまま Codex 子で検索結果一覧を取得したい
- 検索結果の title/snippet を親 Claude に直接入れたくない

以下の場合は対象外:

- 明示的な URL の内容取得が主目的である場合
- Claude 子の `WebSearch` で十分な場合

## 5. 動作環境と制約

前提条件:

- Node.js 23.6 以降
- `codex` CLI がインストール済み
- Codex がログイン済み
- `codex --search exec` が利用可能

重要な制約:

- `codex exec` に `WebSearch only` を厳密強制するオプションは見えていない
- `--search` は親 `codex` コマンド側に付与する必要がある
- `--output-schema` は `error_message` を含め全キー required にする必要がある
- `read-only` を唯一の sandbox 方針とし、失敗時も追加権限には昇格しない

## 6. ディレクトリ構成

```text
guarded-websearch-codex/
├── SKILL.md
├── references/
│   ├── design-plan.md
│   └── search-output-schema.json
└── scripts/
    ├── check-node-version.sh
    ├── codex-jsonl.ts
    ├── quarantine-search-codex.sh
    ├── pipe-sanitize-search-codex.ts
    └── sanitize.ts
```

- `sanitize.ts` は `shared/sanitize/sanitize.ts`、`codex-jsonl.ts` は `shared/codex-jsonl/codex-jsonl.ts` を正本とし、`scripts/sync-shared.ts` で配布された自動生成コピー
- `check-node-version.sh` は main agent の事前チェックと quarantine スクリプトからのサブプロセス呼び出しの両方で使う
- 一時ファイルと隔離用 cwd は `.temp/guarded-websearch-codex/` 配下に実行ごとの `run-XXXXXXXX/` を `mktemp -d` で切り、`trap EXIT` で削除する（並列起動や前回実行の残留ファイル混入を避けるため）

## 7. 実行フロー

### ステップ 1: 検索クエリの特定

- ユーザー要求から検索クエリを決める
- 明示クエリはそのまま使う

### ステップ 2: search + sanitize

各検索クエリに対して以下を実行する。

```bash
bash .claude/skills/guarded-websearch-codex/scripts/quarantine-search-codex.sh '<検索クエリ>'
```

`quarantine-search-codex.sh` は以下を行う。

1. Node.js と `codex` CLI の存在確認
2. クエリの入口検証 (バッククォート / `$()`、制御文字、1000 字上限) を実施
3. `.temp/guarded-websearch-codex/run-XXXXXXXX/` を `mktemp -d` で隔離用 cwd として作成し、`trap EXIT` で削除する
4. `codex --search exec --sandbox read-only --ephemeral --ignore-user-config --ignore-rules --json --output-schema ...` を試行
5. read-only 失敗時は停止し、stderr をそのまま返す
6. JSONL 出力を `pipe-sanitize-search-codex.ts` にパイプ

Codex 子への要求:

- 検索クエリの実行
- 最大 10 件の結果返却
- 各結果に `url`, `title`, `snippet` を含める
- 可能なら Web 検索・Web 閲覧能力だけで完結し、不要なシェル実行をしない
- 最終出力は JSON オブジェクトのみ

### ステップ 3: JSONL 抽出と結果サニタイズ

`pipe-sanitize-search-codex.ts` は以下を行う。

1. stdin から Codex の JSONL イベント列を読む
2. 最終 `agent_message` を抽出する
3. `query`, `results`, `search_success`, `error_message` を検証する
4. `search_success === false` なら fail-closed
5. 各検索結果の `url` を検証し、`http:` / `https:` 以外は除外して `filtered_unsafe_urls` を加算する
6. 各 `title` と `snippet` に `sanitize()` を適用する
7. `aggregate_flags` を集約して `SanitizedSearchOutput` を返す

### ステップ 4: 安全性判定

親 Claude は `aggregate_flags` に基づいて安全性判定を行う。
`reported_query` は Codex 子の自己申告であり、Codex が実際にそのクエリで検索した完全保証ではない点に留意する。

- `suspicious_patterns` が空、`had_invisible_chars` が `false`、`filtered_unsafe_urls` / `dropped_results` が `0`、`query_mismatch` が `false`: 安全
- `had_invisible_chars` が `true` で `suspicious_patterns` が空: 注意
- `dropped_results` が 1 件以上: 注意
- `suspicious_patterns` が非空: 要確認
- `filtered_unsafe_urls` が 1 件以上: 要確認
- `query_mismatch` が `true`: 要確認 (`reported_query` を提示してユーザー確認)

NFKC 正規化は大文字小文字を畳まないため、"AI News" と "AI news" のような case 違いは `query_mismatch` を立てる (検知漏れより過剰検知側に倒す設計の割り切り)。

## 8. サニタイザの処理

`sanitize.ts` は `shared/sanitize/sanitize.ts` の正本から自動生成された共通実装（webfetch-codex を含む全 6 skill で同一）。検索結果では各 `title` と `snippet` に対して個別に `sanitize(url, url, text)` を適用する。

検索結果固有の考慮事項:

- `title` と `snippet` は短文であるため、50,000 文字制限はほぼ防御的措置
- 結果ごとに個別フラグを残せるため、危険な結果だけを伏せる運用がしやすい
- URL 自体はサニタイズ対象ではなく、scheme 検証と unsafe URL 除外で扱う

## 9. 隔離プロセス仕様

### ランタイム制約

| 項目       | 値                                          | 制約の強度 |
| ---------- | ------------------------------------------- | ---------- |
| 親コマンド | `codex --search exec`                       | 準ハード   |
| sandbox    | `read-only` 固定                            | ハード     |
| 永続化     | `--ephemeral`                               | ハード     |
| 出力形式   | `--json`                                    | ハード     |
| schema     | `--output-schema search-output-schema.json` | ハード     |
| cwd        | `-C "$QUARANTINE_CWD"`                      | ハード     |

- `--ignore-user-config --ignore-rules` はホスト側の Codex 設定や execpolicy `.rules` から隔離プロセスの挙動が影響を受けることを避け、再現性と決定論性を高めるために付与する

### 出力スキーマ

```json
{
  "type": "object",
  "required": ["query", "results", "search_success", "error_message"],
  "properties": {
    "query": { "type": "string" },
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["url", "title", "snippet"],
        "properties": {
          "url": { "type": "string" },
          "title": { "type": "string" },
          "snippet": { "type": "string" }
        },
        "additionalProperties": false
      }
    },
    "search_success": { "type": "boolean" },
    "error_message": { "type": "string" }
  },
  "additionalProperties": false
}
```

- `error_message` を required にするのは Codex 側 schema 制約に合わせるため
- `query` は返却値に含めるが、隔離プロセスが実際にどのクエリで検索したかを完全検証するものではない

## 10. テストケース

最低限確認すべきケース:

1. 正常系の検索結果 JSONL 抽出
2. `title` / `snippet` に LLM マーカーが含まれる場合の置換
3. `javascript:` URL の除外
4. `search_success=false` の fail-closed
5. `error` イベントしかない場合の fail-closed
6. read-only 失敗時に stderr をそのまま返して停止する

## 11. 設計上の割り切り

- Codex 子のツール権限を厳密には縛れない
- read-only 失敗時の救済は持たない
- 検索結果の `query` 一致は完全には検証できない
- JSONL イベント形式への依存がある
- title/snippet を静的に無害化しても、自然言語だけの誘導は防げない
- 完全防御ではなく、親 Claude の出力制御が前提

## 12. 将来的な拡張候補

- finer-grained tool permission が出た場合の適用
- CLI イベント schema の厳密化
- 危険結果だけを自動で `[redacted]` 表示する補助ロジック
- `guarded-webfetch-codex` との連携テンプレート強化

## 13. 参考資料

- [`guarded-websearch-claude/references/design-plan.md`](../../guarded-websearch-claude/references/design-plan.md)（基盤となる claude 版 websearch design-plan、同一リポジトリ内）
- [`guarded-webfetch-codex/references/design-plan.md`](../../guarded-webfetch-codex/references/design-plan.md)（codex 版の姉妹スキル webfetch design-plan、同一リポジトリ内）
- Codex CLI `codex exec --help`（CLI ヘルプ出力）
- Codex CLI `codex --help`（CLI ヘルプ出力）
- Codex 公式ドキュメント "Sandbox & approvals" (https://github.com/openai/codex/blob/main/docs/sandbox.md)
- Codex 公式ドキュメント "Advanced configuration"（Sandbox & Approval Settings、`sandbox_mode` 等の解説を含む）(https://developers.openai.com/codex/config-advanced)
- Codex 公式ドキュメント "Configuration reference"（`config.toml` の Security & Sandbox セクション）(https://developers.openai.com/codex/config-reference)
- AWS Security Blog "Defending LLM applications against Unicode character smuggling" (https://aws.amazon.com/blogs/security/defending-llm-applications-against-unicode-character-smuggling/)
- Promptfoo Blog "The Invisible Threat: Zero-Width Unicode Characters" (https://www.promptfoo.dev/blog/invisible-unicode-threats/)
