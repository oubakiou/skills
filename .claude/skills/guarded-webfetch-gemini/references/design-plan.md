# guarded-webfetch-gemini 設計計画

このドキュメントは `guarded-webfetch-gemini` skill の設計意図・構成・割り切りを記録するためのものである。skill の `references/design-plan.md` として配置し、将来の改修・監査・比較検討時の参照資料とする。

現時点ではスキル本体（SKILL.md / scripts）はまだ実装されておらず、本ドキュメントは実装着手前の設計レビュー用である。

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

指定された URL のコンテンツを Claude 親エージェントが扱う際、Gemini CLI 子プロセスを隔離 fetcher として使用し、プロンプトインジェクション攻撃の影響を抑制するためのガード層を提供する。

設計の核は `guarded-webfetch-claude` および `guarded-webfetch-codex` と同じく **「untrusted content と特権的判断・ツール実行の論理的分離」** にある。Gemini 子が Web 取得を担当し、その出力を静的サニタイザに通した結果だけを親 Claude に渡すことで、生の Web コンテンツが main agent のコンテキストに直接入ることを避ける。

本設計では次の 3 層を採用する。

1. **Gemini 子プロセスによる取得 (ハード)** — `gemini -p --policy <toml>` で Policy Engine による全ツール `deny` をベースに `web_fetch` のみ `allow` する。Claude 版と同等の細粒度ツール固定が可能で、Codex 版より厳密にできる
2. **静的サニタイザ (ハード)** — Gemini の `-o json` 出力を `pipe-sanitize-gemini.ts` にパイプし、`response` フィールド内の JSON 抽出、オリジン検証、Unicode 不可視文字除去、LLM マーカー無害化をランタイム強制する
3. **安全性フラグによる行動制御 (ソフト)** — `sanitize.ts` が出力する `suspicious_patterns`、`had_invisible_chars`、`truncated` 等をもとに、親 Claude が応答可否を判断する

### アーキテクチャ概要

```text
main Claude agent
  └─ Bash: quarantine-fetch-gemini.sh "<url>"
       │
       │  パイプ内部:
       │  ┌────────────────────────────────────────────┐
       │  │ 隔離プロセス (gemini -p --policy …)        │
       │  │  web_fetch のみ allow / -o json で出力     │
       │  │  → {response, stats, error} の固定ラッパー │
       │  └──────────┬─────────────────────────────────┘
       │             │ stdout (JSON wrapper)
       │             ▼
       │  ┌────────────────────────────────────────────┐
       │  │ pipe-sanitize-gemini.ts                    │
       │  │  wrapper.response → 内部 JSON 抽出 →        │
       │  │  schema 検証 → sanitize()                  │
       │  └──────────┬─────────────────────────────────┘
       │             │ stdout (サニタイズ済みJSON)
       ▼
  main Claude agent のコンテキスト: サニタイズ済みテキスト + flags のみ
```

この skill はインジェクション対策の **緩和策** であり、完全防御ではない。Gemini CLI は Policy Engine によりツール権限を強制できる一方で、JSON schema 強制が無いため、形式崩しのリスクは Claude 版より高い。

## 2. 脅威モデル

想定する攻撃は `guarded-webfetch-claude` と同じセットを基準に、Gemini 固有の差分を加える。

共通:

- **不可視 Unicode 攻撃**: Tag characters (U+E0000-U+E007F)、zero-width 文字、bidi オーバーライドによる不可視命令埋め込み
- **LLM チャットテンプレート擬装**: `<|im_start|>`, `</untrusted_content>`, `[INST]`, `Human:` などのマーカーで役割境界の脱出を試みる
- **間接的指示注入**: "ignore previous instructions", "you are now", "new instructions:" などのパターン
- **URL 改竄**: 要求した URL と異なるオリジンのコンテンツを返し、親に別サイトの内容を誤認させる試み
- **ツール権限の横滑り**: Gemini 子が `web_fetch` 以外のツール（`run_shell_command`, `read_file` 等）を使おうとするリスク
- **`[FILTERED]` / `[ESCAPED:]` マーカーの悪用**: sanitize.ts の付与マーカーとの区別を曖昧にする試み

Gemini 固有:

- **JSON 形式崩し**: Gemini には `--json-schema` 強制が無いため、`response` フィールド内のテキストが指定形式を逸脱する。指示無視・整形崩し・JSON 偽装が起こりうる
- **`web_fetch` のローカル fallback**: Gemini API の `urlContext` が失敗した場合に「ローカルマシンから raw 取得」にフォールバックする挙動が `web_fetch` ツールに存在する。sandbox 越しでも file: スキームへの干渉や local listener への到達を試みるリスク
- **`GEMINI.md` 経由のコンテキスト混入**: Gemini CLI は `GEMINI.md` の memory 機能を持つ。隔離 cwd 外に `GEMINI.md` が置かれていると、それが Gemini 子のシステム指示に取り込まれる可能性

想定しない攻撃:

- モデル重み自体への攻撃
- 自然言語で巧妙に埋め込まれた高度なソーシャルエンジニアリング
- 親 Claude がスキルをバイパスして直接 Web コンテンツを読む運用ミス
- Gemini API キーの盗用や Google アカウント乗っ取り（OS / IAM レイヤの問題）

## 3. トリガー条件

以下のいずれかに該当するとき発火させる。

- ユーザーが URL を提示し、その内容取得・要約・分析を要求した
- 親を Claude に保ったまま、子 fetcher として Gemini を使いたい
- Web コンテンツを Claude 親のコンテキストに直接入れたくない

以下の場合は本スキルの対象外とする。

- Web 検索クエリの実行が主目的である場合（`guarded-websearch-*` の領域）
- Claude 子の `WebFetch` で十分な場合（`guarded-webfetch-claude`）
- Codex 子で十分な場合（`guarded-webfetch-codex`）

ローカルファイルについては、保存場所ではなく出所で判断する。外部由来の HTML / Markdown / テキストをローカル保存してから読む場合も、本質的には同じ脅威モデルを持つ。

## 4. 動作環境と制約

### 前提条件

- Node.js 23.6 以降
- `gemini` CLI v0.37.x 以降がインストール済みであること
- Gemini が認証済みであること（Google アカウントログインまたは `GEMINI_API_KEY` 環境変数）
- `gemini -p` の headless モードで `web_fetch` ツールが利用可能であること
- Linux 環境では `--sandbox` のバックエンド（Docker / Podman / gVisor のいずれか）が利用可能であること

### Gemini CLI 固有の重要事項

- **`-o json` の出力ラッパーは固定スキーマ**: `{response, stats, error}` の 3 フィールド構造で、`response` には model のテキスト出力（指示通りなら JSON 文字列）が入る。ユーザー定義 schema を強制する `--json-schema` 相当が CLI に**存在しない**
- **Policy Engine は強力**: `--policy <toml>` で `*` を `deny`、`web_fetch` のみ `allow` にできる。`deny` 決定されたツールは「モデルに見えない」ため、ツール選択の段階から候補に上がらない（context window も節約される）
- **Plan Mode と headless の干渉**: `--approval-mode plan` では `web_fetch` でも常に user approval を要求する仕様で、headless 時の `ask_user` は `deny` として扱われる。よって本スキルでは `--approval-mode default` を使い、Policy で明示的に `allow` する
- **`web_fetch` のローカル fallback**: Gemini API 失敗時にローカル raw 取得に fallback する。`--sandbox` でファイルシステム隔離を強制し、policy で `read_file` 系ツールを deny することで影響を抑える
- **GEMINI.md の自動読込**: 隔離 cwd を `.temp/guarded-webfetch-gemini/` に切り替え、その配下に `GEMINI.md` が無いことを保証する

### 環境変数

- `GEMINI_API_KEY`: 認証用。隔離プロセスにも通す必要がある
- `GEMINI_SANDBOX`: `--sandbox` の代替。CLI 引数を優先する
- `SANDBOX_MOUNTS`: マウント追加。隔離スクリプトでは原則設定しない

## 5. ディレクトリ構成

```text
guarded-webfetch-gemini/
├── SKILL.md
├── references/
│   ├── design-plan.md
│   ├── fetch-output-schema.json
│   └── quarantine-fetch-policy.toml
└── scripts/
    ├── quarantine-fetch-gemini.sh
    ├── pipe-sanitize-gemini.ts
    └── sanitize.ts
```

- `sanitize.ts` は `guarded-webfetch-claude` の実装を re-export して共有する
- 一時ファイルや隔離用 cwd は `.temp/guarded-webfetch-gemini/` を使う
- `quarantine-fetch-policy.toml` は Gemini Policy Engine 用の TOML ファイル

## 6. 実行フロー

### ステップ 1: URL の特定

- 明示的な URL をそのまま使う
- 複数 URL は URL ごとに個別処理する
- 並列処理は最大 5 件までとする（Gemini API のレートリミット配慮）

### ステップ 2: fetch + sanitize

各 URL に対して次を実行する。

```bash
.claude/skills/guarded-webfetch-gemini/scripts/quarantine-fetch-gemini.sh '<対象URL>'
```

`quarantine-fetch-gemini.sh` は以下を行う。

1. Node.js と `gemini` CLI の存在確認
2. `GEMINI_API_KEY` または認証済み状態の確認
3. `.temp/guarded-webfetch-gemini/` を隔離用 cwd として作成（既存物が無いことの軽い確認）
4. 隔離 cwd 配下から以下のコマンドを実行
   ```bash
   gemini -p \
     --sandbox \
     --policy "$skill_dir/references/quarantine-fetch-policy.toml" \
     --approval-mode default \
     -o json \
     -m gemini-2.5-flash \
     "<プロンプト>"
   ```
5. Gemini の `-o json` 出力を `pipe-sanitize-gemini.ts` にパイプ
6. パイプの最終 stdout を呼び出し元（main Claude）へ返す

Gemini 子に与えるプロンプトでは次を要求する。

- 対象 URL の本文テキスト取得
- `web_fetch` ツールのみを使うこと
- `raw_text` は可能な限り原文を保つこと
- 50,000 文字超は先頭 50,000 文字に切り詰めること
- 最終出力は次の JSON オブジェクトのみとすること（前後にテキスト無し）
  ```json
  {
    "url": "...",
    "raw_text": "...",
    "fetch_success": true,
    "error_message": ""
  }
  ```
- `web_fetch` が失敗した場合は `fetch_success: false`、`error_message` にエラー詳細を設定すること

### ステップ 3: JSON 抽出とサニタイズ

`pipe-sanitize-gemini.ts` は以下を行う。

1. CLI 引数の URL を検証（`http://` または `https://` のみ許可）
2. stdin から Gemini の `-o json` ラッパー全体を読む
3. ラッパーを JSON parse し、`response`（string）、`stats`（object）、`error`（optional）を取り出す
4. `error` フィールドが存在すれば fail-closed で終了
5. `response` を JSON として再度 parse し、`url`, `raw_text`, `fetch_success`, `error_message` を検証
6. 余計なテキストが前後に付着している場合のフォールバックとして、最初の `{` から最後の `}` までを抽出して再 parse を試みる（プロンプト崩しを 1 段階だけリカバー）。それでも失敗すれば fail-closed
7. `fetch_success === false` なら fail-closed
8. CLI 引数の URL と取得 URL のオリジンを比較し、不一致なら fail-closed
9. `sanitize(requestedUrl, fetchedUrl, rawText)` を実行し、`SanitizedDoc` JSON を stdout に出力

### ステップ 4: 安全性判定

親 Claude は `flags` に基づき安全性判定を行う。

| 条件                                                                                                  | 判定       | 振る舞い                |
| ----------------------------------------------------------------------------------------------------- | ---------- | ----------------------- |
| `suspicious_patterns` が空、`had_invisible_chars` が `false`、`requested_url` と `fetched_url` が一致 | 安全       | 通常応答                |
| `requested_url` と `fetched_url` が異なるが同一オリジン                                               | 注意       | 両 URL を通知           |
| `had_invisible_chars` が `true` で `suspicious_patterns` が空                                         | 注意       | 変形通知付きで応答      |
| `suspicious_patterns` が 1 件以上                                                                     | 要確認     | actionable な出力を保留 |
| `truncated` が `true`                                                                                 | 情報不完全 | 切り詰めを通知          |

## 7. サニタイザの処理層

`sanitize.ts` は `guarded-webfetch-claude` と同じ実装を共有する。対象は Gemini 子が返した本文テキストであり、以下の 2 層に特化する。

### Unicode 層

- NFKC 正規化
- Tag characters の除去
- Zero-width 文字の除去
- LRM / RLM の除去
- Bidi オーバーライドの除去
- 制御文字の除去（タブ・改行を除く）

### LLM マーカー無害化

以下を `[FILTERED:<カテゴリ>]` に置換し、`suspicious_patterns` に記録する。

- `<|im_start|>`, `<|im_end|>`, `<|endoftext|>`
- `<s>`, `<system>`, `<assistant>`, `<user>`, `<untrusted_content>` などの開閉タグ
- `[INST]`, `[/INST]`
- 行頭の `human:`, `assistant:`, `system:`
- `ignore previous instructions`, `new instructions:`, `you are now ...` などの上書きパターン

### 量的制限

- 50,000 文字上限
- truncation は最初に実行し、後続の正規化と走査の処理コスト上限を保証する

## 8. 隔離プロセス仕様

### ランタイム制約

| 項目         | 値                                                            | 制約の強度 |
| ------------ | ------------------------------------------------------------- | ---------- |
| 親コマンド   | `gemini -p`                                                   | ハード     |
| sandbox      | `--sandbox`（Docker / Podman / Seatbelt / gVisor のいずれか） | ハード     |
| ツール制限   | `--policy <toml>` で `*` deny + `web_fetch` allow             | ハード     |
| MCP 制限     | policy 内で `mcp_*` を deny                                   | ハード     |
| 出力形式     | `-o json`                                                     | ハード     |
| 出力スキーマ | （CLI 強制無し。プロンプト指示 + 受信側検証）                 | ソフト     |
| approval     | `--approval-mode default`                                     | ハード     |
| cwd          | `.temp/guarded-webfetch-gemini/`                              | ハード     |
| 認証         | `GEMINI_API_KEY` のみ通し、その他 env は scrub                | 中         |

### Policy TOML（`quarantine-fetch-policy.toml`）

```toml
# 既定: 全ツール deny。deny は「モデルに見えない」ためツール選択候補から除外される。
[[rule]]
toolName = "*"
decision = "deny"
priority = 0

# web_fetch のみ明示 allow。
[[rule]]
toolName = "web_fetch"
decision = "allow"
priority = 100

# MCP 経由のツールも全 deny。
[[rule]]
toolName = "*"
mcpName = "*"
decision = "deny"
priority = 200
```

注意:

- Policy Engine の Workspace tier (`$WORKSPACE_ROOT/.gemini/policies/*.toml`) は現時点で disabled なので、`--policy` フラグで明示指定する
- User tier (`~/.gemini/policies/*.toml`) は本スキルでは触らない（実行ユーザーのカスタム policy を尊重）。`--policy` で渡す本スキル固有 policy は User より下位の Default に近い扱いになるため、ユーザー側で意図的に `web_fetch` を deny している場合は本スキルの allow に勝つ。本スキルが正しく動かない場合はユーザーに確認する

### 出力スキーマ（`fetch-output-schema.json`）

CLI に強制させる手段は無いが、`pipe-sanitize-gemini.ts` のバリデーション基準として保持する。

```json
{
  "type": "object",
  "required": ["url", "raw_text", "fetch_success", "error_message"],
  "properties": {
    "url": { "type": "string" },
    "raw_text": { "type": "string" },
    "fetch_success": { "type": "boolean" },
    "error_message": { "type": "string" }
  },
  "additionalProperties": false
}
```

### `quarantine-fetch-gemini.sh`

このスクリプトは認証情報を最低限通しつつ、それ以外の環境変数をスクラブする。

- **狙い**: `GEMINI_API_KEY` のみを許可し、ホスト側の `GEMINI_*` その他設定が隔離プロセスに漏れないようにする
- **`--sandbox`**: 利用可能なバックエンドを CLI に自動選択させる。明示固定は OS 依存リスクが高いため避ける
- **cwd 切替**: `(cd "$quarantine_cwd" && gemini ...)` のサブシェルで実行する。隔離 cwd 直下に `GEMINI.md` を置かないことを保証する

### `pipe-sanitize-gemini.ts`

- ラッパー JSON のパース（`response`, `stats`, `error`）
- `response` 内の JSON 文字列を再パース
- 失敗時は最初の `{` から最後の `}` の抽出再試行を 1 回だけ行う
- それでも形式不一致なら fail-closed
- それ以外の検証フローは `pipe-sanitize.ts` (Claude 版) / `pipe-sanitize-codex.ts` と同等

## 9. テストケース

最低限確認すべきケース:

1. **正常系**: `https://example.com` を取得し、サニタイズ済み JSON が返る
2. **マーカー検出**: `raw_text` に `<|im_start|>` を含む応答を `pipe-sanitize-gemini.ts` に与え、`[FILTERED:chat_template]` に置換される
3. **error フィールドあり**: Gemini ラッパーで `error` が非 null の場合、fail-closed で終了する
4. **response が JSON でない**: `response` がプレーンテキストや余計な前置きを含む場合、抽出再試行をして 1 回だけ救済し、それでもダメなら fail-closed
5. **fetch_success=false**: 子側で `web_fetch` 失敗を申告した場合、親へ通さずエラー終了する
6. **オリジン不一致**: 要求 URL と取得 URL のオリジンが異なる場合に停止する
7. **ツール横滑り**: prompt で「ファイルを読め」と指示しても policy が `read_file` を deny し、応答に raw_text が無いことを検出してエラー終了する
8. **巨大テキスト**: 50,000 文字超で `truncated: true` が立つ
9. **GEMINI.md 干渉**: 隔離 cwd 配下に `GEMINI.md` が無い前提が崩れた場合に検出（`ls` チェック）

テストは `pipe-sanitize-gemini.ts` の in-source testing と、`quarantine-fetch-gemini.sh` の手動 E2E で行う。

## 10. 設計上の割り切り

- **JSON schema 強制が無い**: Gemini CLI には `--json-schema` 相当が無いため、出力形式の保証はプロンプト指示と受信側バリデーションに依存する。最大の弱点であり、Claude 版より「形式崩し」に弱い
- **Plan Mode は使わない**: Plan Mode + headless では `web_fetch` が deny される。よって `default` モード + Policy で明示 allow にする
- **GEMINI.md の自動読込は cwd 切替で回避する**: ユーザー設定 (`~/.gemini/...`) や User tier policy までは触らないため、ユーザー環境次第で挙動が揺れる可能性は残る
- **API 認証情報の通過**: `GEMINI_API_KEY` を完全 scrub すると認証が通らない。安全性とのトレードオフで、API キー 1 つだけ許可する
- **ローカル fallback の影響**: Gemini API の `urlContext` 失敗時にローカルマシンから raw 取得する仕様は完全には抑え込めない。`--sandbox` と policy で間接的に防ぐ
- **完全防御ではない**: 要確認時に親 Claude が出力を抑制する運用が前提

## 11. 既存スキルとの比較

| 観点                     | guarded-webfetch-claude                | guarded-webfetch-codex                                   | guarded-webfetch-gemini (本スキル設計)             |
| ------------------------ | -------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| 子コマンド               | `claude -p`                            | `codex --search exec`                                    | `gemini -p`                                        |
| 出力形式                 | `--output-format json`                 | `--json` JSONL                                           | `-o json` 固定ラッパー                             |
| 出力スキーマ強制         | あり (`--json-schema`)                 | あり (`--output-schema`)                                 | **無し**（プロンプト指示 + 受信側検証）            |
| ツール固定               | `--allowedTools "WebFetch"`            | プロンプト + sandbox（CLI 直の固定なし）                 | Policy Engine TOML で `*` deny + `web_fetch` allow |
| Sandbox                  | env 変数による cwd 副作用              | `--sandbox read-only` / `workspace-write` フォールバック | `--sandbox` (Docker / Seatbelt / gVisor)           |
| MCP 制限                 | `ENABLE_CLAUDEAI_MCP_SERVERS=false` 等 | プロンプトと sandbox で抑制                              | Policy で `mcp_*` deny                             |
| Memory 自動読込抑止      | `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`     | デフォルトで読まれない                                   | cwd 切替で `GEMINI.md` を含まない位置に            |
| Max turns                | `--max-turns 3`                        | デフォルトの試行回数                                     | （CLI 直の制限が見えていない、要追加調査）         |
| ローカル fallback リスク | 無し                                   | 無し                                                     | あり（`web_fetch` の URL API 失敗時）              |
| 認証                     | Anthropic API key                      | Codex ログイン                                           | `GEMINI_API_KEY` または Google アカウント          |
| ツール権限の強さ         | ハード                                 | 準ハード                                                 | ハード（Policy Engine による強制）                 |
| 出力スキーマ強度         | ハード                                 | ハード                                                   | ソフト                                             |

総評:

- **ツール権限**: Gemini = Claude > Codex
- **出力スキーマ**: Claude = Codex > Gemini
- **Sandbox**: Gemini > Codex > Claude（OS レベル隔離が選べる）

## 12. 将来的な拡張候補

- **Gemini の構造化出力対応**: 将来 CLI で `--json-schema` 相当が追加されたら採用し、出力スキーマ強度を Claude 並みに引き上げる
- **`--policy` の Workspace tier 復活**: 現在 disabled の Workspace tier が復活したら `.gemini/policies/` 配下に置いて `--policy` 引数を省略する形に移行できる
- **guarded-websearch-gemini**: Web 検索結果一覧向けに同じ構造を展開する
- **二段隔離**: Gemini 子を取得専用、別プロセスを要約専用に分離する
- **Sandbox バックエンドの明示固定**: gVisor / Docker のいずれが選ばれているか実行ログで把握できるようにし、最小権限を確実に達成できる構成に絞る

## 13. 残課題と未確定事項

実装着手前に追加で確認・検証したい項目。

- [ ] Gemini CLI に `--max-turns` 相当のフラグがあるか（無ければプロンプトで 1 ターン完結を強制する）
- [ ] `GEMINI.md` 自動読込を確実に無効化するフラグ（または env 変数）の有無
- [ ] `--sandbox` の Linux デフォルトバックエンドが Docker か gVisor か（実環境確認）
- [ ] `web_fetch` のローカル fallback 時、`--sandbox` 越しでファイルアクセスが本当に遮断されるか
- [ ] `-o json` の `response` フィールドに JSON 文字列を含める際、Gemini 側の「出力サニタイゼーション」で改変されないか（`--raw-output` を使う必要があるか。ただし `--raw-output` は警告通り危険な側面もある）
- [ ] 並列実行時のレートリミット挙動と再試行戦略
- [ ] `--policy` の User tier ルールがユーザー環境にある場合の優先順位確認（`web_fetch` が User tier で deny されているケース）

## 14. 参考資料

- [`guarded-webfetch-claude/references/design-plan.md`](../../guarded-webfetch-claude/references/design-plan.md)
- [`guarded-webfetch-codex/references/design-plan.md`](../../guarded-webfetch-codex/references/design-plan.md)
- Gemini CLI 公式ドキュメント
  - <https://geminicli.com/docs/cli/headless>
  - <https://geminicli.com/docs/core/policy-engine>
  - <https://geminicli.com/docs/cli/sandbox>
  - <https://geminicli.com/docs/tools/web-fetch>
  - <https://geminicli.com/docs/reference/commands/>
- AWS "Defending LLM applications against Unicode character smuggling"
- Promptfoo "The Invisible Threat: Zero-Width Unicode Characters"
