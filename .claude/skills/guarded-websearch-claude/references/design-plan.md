# guarded-websearch-claude 設計計画

このドキュメントは `guarded-websearch-claude` skill の設計意図・構成・割り切りを記録するためのものである。skill の `references/design-plan.md` として配置し、将来の改修・移植・監査時の参照資料とする。

## 目次

1. [スキルの目的](#1-スキルの目的)
2. [guarded-webfetch-claude との関係](#2-guarded-webfetch-claude-との関係)
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

Web 検索（WebSearch ツール）の結果を Claude が取り扱う際、検索結果の title・snippet に含まれるプロンプトインジェクション攻撃を抑制するためのガード層を提供する。

guarded-webfetch-claude が個別 URL のコンテンツ取得を対象とするのに対し、本スキルは **検索クエリの実行と検索結果一覧の安全な取得** に特化する。

設計の核は guarded-webfetch-claude と同様、**「untrusted content と特権的判断・ツール実行の論理的分離」**。隔離プロセスとプロセス間パイプにより、生の検索結果が main agent のコンテキストに入ることを防ぐ。

### アーキテクチャ概要

```
main agent
  └─ Bash: claude -p [search] | pipe-sanitize-search.ts "<query>"
       │
       │  パイプ内部:
       │  ┌─────────────────────────────────────────┐
       │  │ 隔離プロセス (claude -p, WebSearch のみ)  │
       │  │  WebSearch → 検索結果 → structured JSON   │
       │  └──────────┬──────────────────────────────┘
       │             │ stdout (JSON: results含む)
       │             ▼
       │  ┌─────────────────────────────────────────┐
       │  │ pipe-sanitize-search.ts (決定論的スクリプト)│
       │  │  results抽出 → 各title/snippetをsanitize │
       │  └──────────┬──────────────────────────────┘
       │             │ stdout (サニタイズ済みJSON)
       ▼
  main agent のコンテキスト: サニタイズ済み検索結果 + flags のみ
       │
       ├─ flags に基づく安全性判定
       └─ サニタイズ済み検索結果をもとに応答を生成
```

## 2. guarded-webfetch-claude との関係

### 分離の理由

guarded-webfetch-claude は元々 WebSearch も扱っていたが、以下の理由で WebSearch 専用スキルとして分離する:

1. **隔離プロセスの構成が異なる**: WebFetch は `--tools "WebFetch"` で単一 URL のコンテンツを取得するが、WebSearch は `--tools "WebSearch"` で検索クエリを実行し複数の結果を返す。ツール制限・settings・出力スキーマがすべて異なる
2. **出力構造が異なる**: WebFetch は単一の raw_text を返すが、WebSearch は複数の title/snippet/url の配列を返す。パイプスクリプトの処理ロジックが異なる
3. **トリガー条件の明確化**: 「URL を指定してコンテンツを取得する」と「検索クエリを実行する」は意味的に異なる操作であり、トリガー条件を分離することで発火精度が向上する

### コード共有

サニタイズロジック（sanitize.ts）は guarded-webfetch-claude 側で一元管理し、本スキルは `import` 経由で共有使用する（`scripts/sanitize.ts` は re-export のみ）。これによりパターン更新時の同期漏れを防ぐ。

**独立性に関するトレードオフ**: この方針により、本スキル (guarded-websearch-claude) は guarded-webfetch-claude が同一リポジトリ内に存在することを前提とする。guarded-webfetch-claude が削除・移動された場合、本スキルの sanitize.ts の import が解決できず動作しない。本スキルを単独で配布・移植する場合は、re-export を実体のコピーに差し替える必要がある。

### 典型的な連携フロー

```
ユーザー: 「○○について調べて」
  ↓
guarded-websearch-claude: WebSearch で検索 → サニタイズ済み検索結果
  ↓
main agent: 検索結果から関連 URL を選定
  ↓
guarded-webfetch-claude: 選定した URL のコンテンツを取得 → サニタイズ済みテキスト
  ↓
main agent: 最終応答を生成
```

## 3. 脅威モデル

想定する攻撃:

- **検索結果の title/snippet へのインジェクション**: 悪意あるサイトが `<meta>` タグや `<title>` に LLM マーカー・指示上書きパターンを埋め込み、検索エンジンのスニペットに表示させる
- **不可視 Unicode 攻撃**: guarded-webfetch-claude と同様。title/snippet に不可視文字を埋め込む
- **LLM チャットテンプレート擬装**: title/snippet に `<|im_start|>` 等を含める
- **間接的指示注入**: title/snippet に "ignore previous instructions" 等を含める
- **検索結果の順位操作による誘導**: SEO ポイズニングにより悪意ある URL を上位に表示させ、ユーザーにクリックさせる

想定しない（この skill では対応しない）攻撃:

- 検索エンジン自体の脆弱性（WebSearch ツール提供元の責任）
- 正当に見える title/snippet 中の高度なソーシャルエンジニアリング
- 個別 URL のコンテンツに含まれるインジェクション（guarded-webfetch-claude の責任）

## 4. トリガー条件

以下のいずれかに該当するとき必ず発火させる:

- ユーザーが「○○について調べて」「○○を検索して」等の Web 検索要求をした
- `WebSearch` ツールを使う前
- 検索クエリを実行して結果を取得しようとしている

以下の場合は **発火しない**（guarded-webfetch-claude を使用する）:

- ユーザーが明示的な URL を指定してコンテンツの取得・要約・分析を要求した場合
- 検索結果から選定した URL のコンテンツを取得する場合

## 5. 動作環境と制約

guarded-webfetch-claude と同様の環境制約を持つ:

- **Node.js v23.6 以降が必須**（type stripping でそのまま実行）
- **外部パッケージ依存ゼロ**（sanitize.ts を guarded-webfetch-claude から import）
- **Claude Code 前提**（`claude -p` による隔離プロセス）
- **認証は親プロセスの認証を継承**
- **隔離プロセスのモデルは指定しない**

### 環境変数による隔離強化

guarded-webfetch-claude と同一の環境変数を設定する:

| 環境変数                                  | 値      | 効果                               |
| ----------------------------------------- | ------- | ---------------------------------- |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS`          | `1`     | CLAUDE.md の自動読込を無効化       |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`        | `1`     | 認証情報のスクラブ                 |
| `ENABLE_CLAUDEAI_MCP_SERVERS`             | `false` | claude.ai MCP サーバーを無効化     |
| `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` | `1`     | ビルトインサブエージェントを無効化 |
| `CLAUDE_CODE_SKIP_PROMPT_HISTORY`         | `1`     | セッション履歴の書き込みを無効化   |

## 6. ディレクトリ構成

```
guarded-websearch-claude/
├── SKILL.md
├── scripts/
│   ├── sanitize.ts               # テキストサニタイザ（guarded-webfetch-claude と同一）
│   └── pipe-sanitize-search.ts   # 隔離プロセス出力→sanitize→stdout パイプスクリプト
└── references/
    ├── design-plan.md             # このドキュメント
    ├── search-output-schema.json  # 隔離プロセス用 --json-schema
    ├── quarantine-search-settings.json  # 隔離プロセス用 permission 設定
    └── injection_patterns.md      # guarded-webfetch-claude のパターン集を参照
```

sanitize.ts は guarded-webfetch-claude 側で一元管理し、本スキルは re-export 経由で import する（詳細はセクション 2 参照）。

## 7. 実行フロー

**ステップ 0: 前提条件チェック**

guarded-webfetch-claude と同一。Node.js 23.6 以降のバージョンチェック。

**ステップ 1: 検索クエリの特定**

ユーザー要求から検索クエリを特定する。

**ステップ 2: search + sanitize（パイプ接続）**

隔離プロセスと pipe-sanitize-search.ts をパイプで接続して実行する。

```bash
skill_dir=".claude/skills/guarded-websearch-claude"
search_schema="$(cat "$skill_dir/references/search-output-schema.json")"
search_settings="$skill_dir/references/quarantine-search-settings.json"

CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 \
CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 \
ENABLE_CLAUDEAI_MCP_SERVERS=false \
CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1 \
CLAUDE_CODE_SKIP_PROMPT_HISTORY=1 \
claude -p \
  --tools "WebSearch" \
  --allowedTools "WebSearch" \
  --settings "$search_settings" \
  --json-schema "$search_schema" \
  --output-format json \
  --max-turns 3 \
  "（隔離プロセス用プロンプト — 正式なテンプレートは SKILL.md を参照）" \
  | node "$skill_dir/scripts/pipe-sanitize-search.ts" '<検索クエリ>'
```

pipe-sanitize-search.ts は以下を行う:

1. stdin から `claude -p --output-format json` の出力 JSON を読む
2. `subtype === "success"` と `structured_output.results` の存在を検証
3. 各検索結果の `title` と `snippet` に対して sanitize.ts の `sanitize()` 関数を呼ぶ
4. サニタイズ済み結果（`SanitizedSearchOutput` JSON）を stdout に出力
5. 検証失敗時は stderr にエラーを出力し exit code 1 で終了

> **CLI 引数のクエリの役割と限界**: pipe-sanitize-search.ts は CLI 引数で渡されたクエリを出力の `query` フィールドに使用し、表示上のクエリがユーザーの意図と一致することを保証する。ただし、これは隔離プロセスが実際に実行した検索クエリを検証するものではない。隔離プロセスが別のクエリで検索した場合、結果は別のクエリのものであっても出力の `query` フィールドだけが CLI 引数の値になる。これは既知の限界であり、隔離プロセスの制約（`--tools "WebSearch"`, `--max-turns 3`, スキーマ強制）が実質的な防御線となる。

**ステップ 3: 安全性判定**

pipe-sanitize-search.ts の出力に含まれる `aggregate_flags` に基づき、main agent が安全性を判定する。判定基準は SKILL.md のステップ 3 を参照。

**ステップ 4: 最終応答の生成**

サニタイズ済み検索結果をもとに応答を生成する。URL のみを信頼可能なデータとして扱い、title・snippet は参考情報として扱う。

## 8. サニタイザの処理

guarded-webfetch-claude の sanitize.ts を共有使用する。検索結果の各 title・snippet に対して個別に `sanitize(url, text)` を呼び出す。

処理層の詳細は guarded-webfetch-claude の design-plan.md セクション 7 を参照。

### 検索結果固有の考慮事項

- title・snippet は比較的短いテキスト（数百文字以下）であるため、50,000 文字の truncate 制限に達することはまずない
- 検索結果ごとに個別にフラグが記録されるため、どの結果に問題があるかを特定できる
- `aggregate_flags` で全結果のフラグを集約し、安全性判定の入力とする

## 9. 隔離プロセス仕様

### ランタイム制約

| フラグ / 環境変数 | 値                                | 制約の強度                                      |
| ----------------- | --------------------------------- | ----------------------------------------------- |
| `--tools`         | `"WebSearch"`                     | ハード（WebSearch のみ）                        |
| `--allowedTools`  | `"WebSearch"`                     | WebSearch を自動許可                            |
| `--settings`      | `quarantine-search-settings.json` | ハード（後述）                                  |
| 環境変数          | セクション 5 参照                 | ハード                                          |
| `--output-format` | `json`                            | ハード                                          |
| `--json-schema`   | `search-output-schema.json`       | ハード                                          |
| `--max-turns`     | `3`                               | ハード（WebSearch 1 回 + リトライ 1 回 + 出力） |

### settings（`quarantine-search-settings.json`）

```json
{
  "permissions": {
    "allow": ["WebSearch"],
    "deny": [
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Bash",
      "Agent",
      "Glob",
      "Grep",
      "NotebookEdit",
      "WebFetch"
    ]
  }
}
```

- `allow` に WebSearch のみ
- `deny` に WebFetch を含む: WebSearch 専用の隔離プロセスが URL のコンテンツを取得するのを防ぐ（defense in depth）

### 出力スキーマ（`search-output-schema.json`）

```json
{
  "type": "object",
  "required": ["query", "results", "search_success"],
  "properties": {
    "query": { "type": "string", "maxLength": 500 },
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["url", "title", "snippet"],
        "properties": {
          "url": { "type": "string" },
          "title": { "type": "string", "maxLength": 500 },
          "snippet": { "type": "string", "maxLength": 2000 }
        },
        "additionalProperties": false
      },
      "maxItems": 10
    },
    "search_success": { "type": "boolean" },
    "error_message": { "type": "string", "maxLength": 500 }
  },
  "additionalProperties": false
}
```

- `title` の `maxLength: 500`: タイトルとして十分な長さを確保しつつ、攻撃ペイロードのサイズを抑える
- `snippet` の `maxLength: 2000`: スニペットとして十分な長さを確保しつつ制限
- `results` の `maxItems: 10`: 結果数の上限を設定し、大量の結果による攻撃面の拡大を抑える（プロンプトの「最大10件」指示と一致）

## 10. テストケース

1. **通常ケース**: 検索クエリ → 隔離プロセスで WebSearch → パイプで sanitize → main agent がサニタイズ済み結果をもとに応答
2. **title にインジェクション**: title に `<|im_start|>` を含む検索結果 → pipe-sanitize-search.ts が `[FILTERED:chat_template]` に置換、`suspicious_patterns` に記録
3. **snippet にインジェクション**: snippet に `ignore all previous instructions` を含む → `[FILTERED:instruction_override]` に置換
4. **不可視文字**: title/snippet に zero-width 文字を含む → 除去、`had_invisible_chars: true`
5. **複数結果の混在**: 10 件中 2 件にインジェクション → 該当 2 件のフラグが個別に記録、`aggregate_flags` に集約
6. **環境チェック**: Node.js 23.6 未満 → 処理を開始せず、バージョン要件メッセージ
7. **WebSearch 失敗**: 隔離プロセスの WebSearch が失敗 → `search_success: false`、pipe-sanitize-search.ts が exit code 1
8. **不正な結果アイテム**: results 配列に不正なオブジェクトが含まれる → スキップして正常な結果のみ処理
9. **空の検索結果**: 検索結果が 0 件 → 空配列として正常に処理
10. **`[FILTERED]` 偽装攻撃**: title/snippet に `[FILTERED]` を含む → `[ESCAPED:FILTERED]` にエスケープ

テストは pipe-sanitize-search.ts の単体テストとして自動化する（Vitest の in-source testing 機能を使用）。

## 11. 設計上の割り切り

- **sanitize.ts の import 依存**: sanitize.ts は guarded-webfetch-claude 側で一元管理し、本スキルは re-export 経由で import する。パターン更新の同期漏れは防げるが、本スキルは guarded-webfetch-claude が同一リポジトリ内に存在しないと動作しない（独立性のトレードオフ）。単独配布時は re-export を実体のコピーに差し替える必要がある
- **検索結果の URL はスキーム検証済みで通す**: `sanitizeSearchResults()` で各結果の URL スキームを検証し、`http:` / `https:` 以外のスキーム（`javascript:`, `file:`, `data:` 等）を持つ結果は除外する。除外件数は `meta.filtered_unsafe_urls` に記録される。URL の内容自体のサニタイズは対象外だが、URL を actionable な推奨として出力する際は guarded-webfetch-claude を経由させる
- **SEO ポイズニングは対象外**: 悪意ある URL が検索上位に表示されることによる誘導は、検索エンジン側の問題であり本スキルの対象外
- **検索クエリの改竄は検証不能**: CLI 引数のクエリ上書きは出力の `query` フィールドの表示を保証するだけであり、隔離プロセスが実際に実行した検索クエリを検証する手段はない。webfetch のオリジン比較に相当する検証メカニズムが検索クエリには存在しないため、隔離プロセスの制約（`--tools "WebSearch"`, `--max-turns 3`, スキーマ強制）が実質的な防御線となる
- **クエリのシェルインジェクション防止はソフト制約**: guarded-webfetch-claude の URL と同様、プロンプト文字列へのシェル展開防止は main agent のソフト判断に依存
- **完全防御ではない**: guarded-webfetch-claude と同様の緩和策
- **WebSearch の返却形式への依存**: WebSearch ツールの返却形式が変更された場合、隔離プロセスのプロンプトと出力スキーマの更新が必要

## 12. 将来的な拡張候補

- **検索結果のクロスバリデーション**: 複数の検索エンジンの結果を比較し、一致しない結果を疑わしいとしてフラグする
- **URL レピュテーションチェック**: 既知の悪意あるドメインリストとの照合
- **guarded-webfetch-claude との統合ワークフロー**: 検索 → URL 選定 → コンテンツ取得の一連のフローを自動化するメタスキル

## 13. 参考資料

- guarded-webfetch-claude の design-plan.md: 基盤となる設計・脅威モデル・参考文献
- Simon Willison "Dual LLM pattern" -- https://simonwillison.net/2023/Apr/25/dual-llm-pattern/
- Google DeepMind CaMeL -- https://arxiv.org/abs/2503.18813
