# guarded-websearch-gemini 設計計画

このドキュメントは `guarded-websearch-gemini` skill の設計意図・構成・割り切りを記録するためのものである。skill の `references/design-plan.md` として配置し、将来の改修・監査・比較検討時の参照資料とする。

## 目次

1. [スキルの目的](#1-スキルの目的)
2. [脅威モデル](#2-脅威モデル)
3. [トリガー条件](#3-トリガー条件)
4. [動作環境と制約](#4-動作環境と制約)
5. [ディレクトリ構成](#5-ディレクトリ構成)
6. [実行フロー](#6-実行フロー)
7. [サニタイザの処理層](#7-サニタイザの処理層)
8. [隔離プロセス仕様](#8-隔離プロセス仕様)
9. [テストケース](#9-テストケース)
10. [設計上の割り切り](#10-設計上の割り切り)
11. [既存スキルとの比較](#11-既存スキルとの比較)
12. [将来的な拡張候補](#12-将来的な拡張候補)
13. [残課題と未確定事項](#13-残課題と未確定事項)
14. [参考資料](#14-参考資料)

## 1. スキルの目的

Web 検索クエリの実行結果を Claude 親エージェントが扱う際、Gemini CLI 子プロセスを隔離 searcher として使用し、プロンプトインジェクション攻撃の影響を抑制するためのガード層を提供する。

設計の核は `guarded-webfetch-gemini` と同じく **「untrusted content と特権的判断・ツール実行の論理的分離」** にある。Gemini 子が Web 検索を担当し、その出力を静的サニタイザに通した結果だけを親 Claude に渡すことで、生の検索結果（title・snippet）が main agent のコンテキストに直接入ることを避ける。

本設計では次の 3 層を採用する。

1. **Gemini 子プロセスによる検索 (ハード)** — `gemini -p --policy <toml>` で Policy Engine による全ツール `deny` をベースに `google_web_search` のみ `allow` する
2. **静的サニタイザ (ハード)** — Gemini の `-o json` 出力を `pipe-sanitize-search-gemini.ts` にパイプし、`response` フィールド内の JSON 抽出、検索結果ごとの Unicode 不可視文字除去、LLM マーカー無害化をランタイム強制する
3. **安全性フラグによる行動制御 (ソフト)** — `aggregate_flags` の `suspicious_patterns`、`had_invisible_chars`、`query_mismatch` 等をもとに、親 Claude が応答可否を判断する

### アーキテクチャ概要

```text
main Claude agent
  └─ Bash: quarantine-search-gemini.sh "<query>"
       │
       │  パイプ内部:
       │  ┌────────────────────────────────────────────┐
       │  │ 隔離プロセス (gemini -p --policy …)        │
       │  │  google_web_search のみ allow / -o json    │
       │  │  → {response, stats, error} の固定ラッパー │
       │  └──────────┬─────────────────────────────────┘
       │             │ stdout (JSON wrapper)
       │             ▼
       │  ┌────────────────────────────────────────────┐
       │  │ pipe-sanitize-search-gemini.ts             │
       │  │  wrapper.response → 内部 JSON 抽出 →       │
       │  │  結果ごとに title/snippet を sanitize()    │
       │  └──────────┬─────────────────────────────────┘
       │             │ stdout (サニタイズ済みJSON)
       ▼
  main Claude agent のコンテキスト: サニタイズ済み検索結果 + flags のみ
```

この skill はインジェクション対策の **緩和策** であり、完全防御ではない。Gemini CLI は Policy Engine によりツール権限を強制できる一方で、JSON schema 強制が無いため、形式崩しのリスクは Claude 版より高い。

## 2. 脅威モデル

想定する攻撃は `guarded-websearch-claude` と同じセットを基準に、Gemini 固有の差分を加える。

共通:

- **検索結果の title / snippet に仕込まれた LLM マーカー**: `<|im_start|>`, `[INST]`, `Human:` 等を検索結果に埋め込み、親 Claude の役割境界を崩す
- **不可視 Unicode 攻撃**: Tag characters、zero-width 文字、bidi オーバーライドによる不可視命令埋め込み
- **間接的指示注入**: "ignore previous instructions", "you are now" 等のパターンを title/snippet に含む
- **URL スキーム改竄**: `javascript:`, `file:`, `data:` 等の非 HTTP スキームの URL を検索結果に混入
- **クエリ改竄**: 隔離プロセスが CLI 引数と異なるクエリを実行し、意図しない結果を親に渡す
- **`[FILTERED]` / `[ESCAPED:]` マーカーの悪用**: sanitize.ts の付与マーカーとの区別を曖昧にする試み

Gemini 固有:

- **JSON 形式崩し**: Gemini には `--json-schema` 強制が無いため、`response` フィールド内のテキストが指定形式を逸脱する
- **`GEMINI.md` 経由のコンテキスト混入**: 隔離 cwd 外に `GEMINI.md` が置かれていると、Gemini 子のシステム指示に取り込まれる可能性
- **ツール権限の横滑り**: Gemini 子が `google_web_search` 以外のツール（`web_fetch`, `run_shell_command` 等）を使おうとするリスク

### `guarded-webfetch-gemini` との差分

webfetch-gemini では `web_fetch` のローカル fallback が主要な Gemini 固有脅威だったが、websearch では `google_web_search` がローカルリソースにアクセスする経路は無いため、この脅威は対象外。代わりに検索結果の title/snippet が外部サイト由来の untrusted データであるという websearch 共通の脅威が中心になる。

### sanitize.ts の共有と独立性

本スキルの `sanitize.ts` は `guarded-webfetch-gemini` の実装を re-export する。同一 LLM ファミリ（Gemini 系）のスキル間では共有し、異なる LLM ファミリ（Claude / Codex）からは import しない方針を採る。

単独配布が必要になった場合は、re-export を直接コピーに差し替える。

## 3. トリガー条件

以下のいずれかに該当するとき発火させる。

- ユーザーが Web 検索を要求した（「○○について調べて」「○○を検索して」等）
- 親を Claude に保ったまま、子 searcher として Gemini を使いたい

以下の場合は本スキルの対象外とする。

- 特定 URL のコンテンツ取得が主目的である場合（`guarded-webfetch-gemini` の領域）
- Claude 子の `WebSearch` で十分な場合（`guarded-websearch-claude`）
- Codex 子で十分な場合（`guarded-websearch-codex`）

## 4. 動作環境と制約

### 前提条件

- Node.js 23.6 以降
- `gemini` CLI v0.40.x 以降がインストール済みであること
- Gemini が認証済みであること（Google アカウントログイン (`~/.gemini/oauth_creds.json`) または `GEMINI_API_KEY` 環境変数）
- `gemini -p` の headless モードで `google_web_search` ツールが利用可能であること
- **`--skip-trust` が必須**。指定しないと workspace trust 未確認の cwd では headless が exit code 55 で停止する
- gVisor (runsc) がインストール済みであれば sandbox を有効化する。セットアップ手順は `guarded-webfetch-gemini/references/design-plan.md` §4 を参照

### 環境変数の取り扱い (whitelist 方式)

`quarantine-search-gemini.sh` は `env -i` で親 env を全消去した上で、以下のみを明示的に通す。`guarded-webfetch-gemini` と同一の whitelist 設計。

| 環境変数                         | 通す理由                                                            |
| -------------------------------- | ------------------------------------------------------------------- |
| `PATH`                           | `gemini` バイナリ・sandbox バックエンドの実行に必須                 |
| `HOME`                           | Gemini CLI が `~/.gemini/` 配下の認証トークンや設定を読むために必要 |
| `GEMINI_API_KEY`                 | API key 認証時の主要経路                                            |
| `GOOGLE_API_KEY`                 | Google AI Studio 経由の代替認証                                     |
| `GOOGLE_APPLICATION_CREDENTIALS` | ADC のサービスアカウント JSON パス                                  |
| `GOOGLE_GENAI_USE_VERTEXAI`      | Vertex AI 経由のときに必要                                          |
| `GOOGLE_CLOUD_PROJECT`           | Vertex AI 経由でのプロジェクト指定                                  |
| `LANG` / `LC_ALL` / `TZ`         | ロケール・タイムゾーン依存の出力差異を避けるため                    |

詳細は `guarded-webfetch-gemini/references/design-plan.md` §4 を参照。

## 5. ディレクトリ構成

```text
guarded-websearch-gemini/
├── SKILL.md
├── references/
│   ├── design-plan.md
│   ├── search-output-schema.json
│   └── quarantine-search-policy.toml
└── scripts/
    ├── check-node-version.sh
    ├── quarantine-search-gemini.sh
    ├── pipe-sanitize-search-gemini.ts
    └── sanitize.ts
```

- `sanitize.ts` は `guarded-webfetch-gemini` の sanitize.ts を re-export する（同一 LLM ファミリ内での共有）
- `check-node-version.sh` は main agent の事前チェックと `quarantine-search-gemini.sh` の冒頭チェックの両方で使う多層防御
- 一時ファイルや隔離用 cwd は `.temp/guarded-websearch-gemini/` 配下に実行ごとの `run-XXXXXXXX/` を `mktemp -d` で切り、`trap EXIT` で削除する
- `quarantine-search-policy.toml` は Gemini Policy Engine 用の TOML ファイル（`google_web_search` のみ allow）

## 6. 実行フロー

### ステップ 0: 前提条件チェック

```bash
.claude/skills/guarded-websearch-gemini/scripts/check-node-version.sh
```

Node.js 23.6 未満の場合は exit code 3 で終了。

### ステップ 1: 検索クエリの特定

ユーザーの要求から適切な検索クエリを生成する。

### ステップ 2: search + sanitize

```bash
.claude/skills/guarded-websearch-gemini/scripts/quarantine-search-gemini.sh '<検索クエリ>'
```

`quarantine-search-gemini.sh` は以下を行う:

1. Node.js と `gemini` CLI の存在確認
2. クエリの入口検証（禁止文字、制御文字、長さ上限 1000 字）
3. 認証確認
4. 隔離用 cwd を `mktemp -d` で作成
5. sandbox 検出（runsc 利用可能時のみ有効化）
6. `env -i` + whitelist で `gemini -p` を実行（Policy Engine で `google_web_search` のみ allow）
7. Gemini の `-o json` 出力を `pipe-sanitize-search-gemini.ts` にパイプ

### ステップ 3: JSON 抽出とサニタイズ

`pipe-sanitize-search-gemini.ts` は以下を行う:

1. CLI 引数のクエリを検証（必須・長さ上限）
2. stdin から Gemini の `-o json` ラッパーを読む
3. ラッパーを JSON parse し、`error` / `response` / `stats` を検証
4. `stats.tools.byName.google_web_search.count` を検証（0 なら Policy deny と判断）
5. `response` 内の JSON を再 parse し、`query`, `results`, `search_success` を検証
6. 各検索結果の title / snippet に `sanitize()` を適用
7. CLI 引数のクエリと隔離プロセス申告のクエリを比較（`query_mismatch` 検出）
8. サニタイズ済み結果 + `aggregate_flags` を stdout に出力

### ステップ 4: 安全性判定

親 Claude は `aggregate_flags` に基づき安全性判定を行う。websearch-claude / websearch-codex と同じ二層構造（`aggregate_flags` + 個別 `title_flags` / `snippet_flags`）。

## 7. サニタイザの処理層

`sanitize.ts` は `guarded-webfetch-gemini` の実装を re-export する。検索結果の title / snippet それぞれに適用する。

処理層の詳細は `guarded-webfetch-gemini/references/design-plan.md` §7 を参照。

## 8. 隔離プロセス仕様

### ランタイム制約

| 項目         | 値                                                          | 制約の強度 |
| ------------ | ----------------------------------------------------------- | ---------- |
| 親コマンド   | `gemini -p`                                                 | ハード     |
| タイムアウト | `timeout 60` (プロセスレベル 60 秒)                         | ハード     |
| sandbox      | `--sandbox` + `GEMINI_SANDBOX=runsc` (runsc 利用可能時のみ) | 条件付き   |
| ツール制限   | `--policy <toml>` で `*` deny + `google_web_search` allow   | ハード     |
| MCP 制限     | policy 内で `mcp_*` を deny                                 | ハード     |
| 出力形式     | `-o json`                                                   | ハード     |
| 出力スキーマ | （CLI 強制無し。プロンプト指示 + 受信側検証）               | ソフト     |
| approval     | `--approval-mode default`                                   | ハード     |
| cwd          | `.temp/guarded-websearch-gemini/`                           | ハード     |

### Policy TOML（`quarantine-search-policy.toml`）

```toml
[[rule]]
toolName = "*"
decision = "deny"
priority = 0

[[rule]]
toolName = "google_web_search"
decision = "allow"
priority = 100

[[rule]]
toolName = "*"
mcpName = "*"
decision = "deny"
priority = 200
```

`guarded-webfetch-gemini` の `quarantine-fetch-policy.toml` と同じ構造で、allow 対象が `web_fetch` → `google_web_search` に変わっただけ。Policy Engine の tier 挙動や priority の根拠は `guarded-webfetch-gemini/references/design-plan.md` §8 を参照。

### Exit code 一覧

| Exit code | 意味                                                 | 発生元                           |
| --------- | ---------------------------------------------------- | -------------------------------- |
| 0         | 正常終了                                             | —                                |
| 1         | Gemini CLI の一般エラー (レートリミット最終失敗含む) | `quarantine-search-gemini.sh`    |
| 2         | クエリ入口検証失敗 (禁止文字 / 制御文字 / 長さ上限)  | `quarantine-search-gemini.sh`    |
| 3         | Node.js 23.6 未満                                    | `check-node-version.sh`          |
| 4         | Policy tier 由来の `google_web_search` deny 検出     | `pipe-sanitize-search-gemini.ts` |
| 124       | タイムアウト (60 秒超過)                             | `timeout` コマンド               |

## 9. テストケース

最低限確認すべきケース:

1. **正常系**: 検索クエリを実行し、サニタイズ済み JSON が返る
2. **マーカー検出**: title/snippet に `<|im_start|>` を含む応答を与え、`[FILTERED:chat_template]` に置換される
3. **error フィールドあり**: Gemini ラッパーで `error` が非 null の場合、fail-closed で終了する
4. **response が JSON でない**: 前置きを含む場合、抽出再試行を 1 回だけ行い、ダメなら fail-closed
5. **search_success=false**: 子側で検索失敗を申告した場合、エラー終了する
6. **ツール横滑り**: policy が他ツールを deny し、`google_web_search` のみ実行可能
7. **query_mismatch**: 隔離プロセスが異なるクエリを申告した場合に検出される
8. **MAX_RESULTS 超過**: 10 件超の結果が返された場合に切り詰める
9. **unsafe URL**: `javascript:`, `file:`, `data:` スキームの URL が除外される
10. **環境チェック**: Node.js 23.6 未満 → exit code 3
11. **Policy deny 検出**: `google_web_search` が deny された状態 → exit code 4
12. **タイムアウト**: 60 秒超過 → exit code 124
13. **不可視文字**: title/snippet 内の不可視 Unicode が除去されフラグが立つ
14. **`[FILTERED]` 偽装攻撃**: `[FILTERED]` / `[ESCAPED:FILTERED]` が再帰エスケープされる

テストは `pipe-sanitize-search-gemini.ts` の in-source testing (Vitest) と、`quarantine-search-gemini.sh` の手動 E2E で行う。

## 10. 設計上の割り切り

`guarded-webfetch-gemini` と共通する割り切り（JSON schema 強制無し、GEMINI.md 自動読込、`.env` 上方再帰読込、Workspace trust skip 等）は `guarded-webfetch-gemini/references/design-plan.md` §10 を参照。本セクションでは websearch 固有の割り切りを記載する。

- **`google_web_search` はローカル fallback が無い**: `web_fetch` と異なり、`google_web_search` にはローカルマシンへの fallback 機構は存在しない。このため sandbox の必要性は webfetch ほど高くないが、ツール横滑り防止のために sandbox を併用する方針は維持する
- **検索結果の URL は未検証**: 検索結果に含まれる URL は Gemini 子の自己申告であり、実在検証やオリジン検証は行わない。actionable な推奨として出力する際は `guarded-webfetch-gemini` 経由でコンテンツを取得させる
- **クエリ検証不能**: CLI 引数のクエリは出力の `query` フィールドに固定するが、隔離プロセスが実際に実行したクエリを検証する手段はない。`reported_query` とのサニタイズ後比較で差異を検出するが、Gemini がクエリを言い換えて実行する正常ケースも query_mismatch として検出される
- **NFKC は大文字小文字を畳まない**: "AI News" と "AI news" のような case 違いは `query_mismatch` が立つ。検知漏れより過剰検知側に倒す設計
- **sanitize.ts の re-export**: `guarded-webfetch-gemini` の sanitize.ts を re-export する依存構造のため、webfetch-gemini が存在しない環境では動作しない

## 11. 既存スキルとの比較

| 観点             | guarded-websearch-claude       | guarded-websearch-codex          | guarded-websearch-gemini (本スキル)     |
| ---------------- | ------------------------------ | -------------------------------- | --------------------------------------- |
| 子コマンド       | `claude -p`                    | `codex --search exec`            | `gemini -p`                             |
| 使用ツール       | WebSearch                      | Codex 組み込み search            | google_web_search                       |
| 出力形式         | `--output-format json`         | `--json` JSONL                   | `-o json` 固定ラッパー                  |
| 出力スキーマ強制 | あり (`--json-schema`)         | あり (`--output-schema`)         | **無し**（プロンプト指示 + 受信側検証） |
| ツール固定       | `--allowedTools "WebSearch"`   | プロンプト + sandbox             | Policy Engine で `*` deny + allow       |
| Sandbox          | なし (env + permission の多層) | read-only / workspace-write      | gVisor (runsc 利用可能時のみ)           |
| クエリ検証       | query_mismatch                 | query_mismatch                   | query_mismatch                          |
| sanitize.ts      | webfetch-claude から re-export | webfetch-claude 系から re-export | webfetch-gemini から re-export          |
| 出力構造         | aggregate_flags + 個別 flags   | aggregate_flags + 個別 flags     | aggregate_flags + 個別 flags            |

## 12. 将来的な拡張候補

- **Gemini の構造化出力対応**: 将来 CLI で `--json-schema` 相当が追加されたら採用し、出力スキーマ強度を引き上げる
- **検索結果の重複排除**: 同一 URL の重複結果を検出・除外する機能
- **sanitize.ts の独立化**: 単独配布が必要になった場合に re-export を直接コピーに差し替える

## 13. 残課題と未確定事項

### A. 実装ブロッカー

なし。`guarded-webfetch-gemini` の PoC で確認済みの事実（Policy Engine の挙動、`-o json` のラッパー構造、sandbox の動作等）をそのまま適用する。

### B. 実装と並行で確認

- [ ] **`google_web_search` の stats 出力形式**: `web_fetch` と同様に `stats.tools.byName.google_web_search.{count, success, fail}` が出力されるか実機確認
- [ ] **GEMINI.md 自動読込を抑止する公式手段**: `guarded-webfetch-gemini` §13 と共通。見つからなければ割り切りとして恒久化
- [ ] **`.env` 上方再帰読込の抑止**: `guarded-webfetch-gemini` §13 と共通

### C. 継続観察

- [ ] **`--policy` が Admin tier 相当に振る舞う根拠**: `guarded-webfetch-gemini` §13 と共通
- [ ] **トークン消費とレートリミット**: `google_web_search` のトークン消費パターンの観察

## 14. 参考資料

- [`guarded-webfetch-gemini/references/design-plan.md`](../../guarded-webfetch-gemini/references/design-plan.md) — Gemini CLI 固有の設計詳細（Policy Engine、sandbox、env whitelist 等）の正典
- [`guarded-websearch-claude/references/design-plan.md`](../../guarded-websearch-claude/references/design-plan.md) — websearch 共通の設計パターン（二層フラグ構造、query_mismatch 等）
- [`guarded-websearch-codex/references/design-plan.md`](../../guarded-websearch-codex/references/design-plan.md) — Codex 版 websearch の設計
- Gemini CLI 公式リポジトリ — <https://github.com/google-gemini/gemini-cli>
