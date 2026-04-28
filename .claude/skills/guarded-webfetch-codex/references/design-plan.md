# guarded-webfetch-codex 設計計画

このドキュメントは `guarded-webfetch-codex` skill の設計意図・構成・割り切りを記録するためのものである。skill の `references/design-plan.md` として配置し、将来の改修・監査・比較検討時の参照資料とする。

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
11. [将来的な拡張候補](#11-将来的な拡張候補)
12. [参考資料](#12-参考資料)

## 1. スキルの目的

指定された URL のコンテンツを Claude 親エージェントが扱う際、Codex 子プロセスを隔離 fetcher として使用し、プロンプトインジェクション攻撃の影響を抑制するためのガード層を提供する。

設計の核は `guarded-webfetch-claude` と同じく **「untrusted content と特権的判断・ツール実行の論理的分離」** にある。Codex 子が Web 取得を担当し、その出力を静的サニタイザに通した結果だけを親 Claude に渡すことで、生の Web コンテンツが main agent のコンテキストに直接入ることを避ける。

本設計では次の 3 層を採用する。

1. **Codex 子プロセスによる取得 (準ハード)** — `codex --search exec` を使って URL の本文テキスト取得を担当させる。Claude 版の `WebFetch only` ほど厳密なツール固定はできないため、「準ハード」と位置付ける
2. **静的サニタイザ (ハード)** — 子プロセスの JSONL 出力を `pipe-sanitize-codex.ts` にパイプし、最終 JSON メッセージの抽出、オリジン検証、Unicode 不可視文字除去、LLM マーカー無害化をランタイム強制する
3. **安全性フラグによる行動制御 (ソフト)** — `sanitize.ts` が出力する `suspicious_patterns`、`had_invisible_chars`、`truncated` 等をもとに、親 Claude が応答可否を判断する

### アーキテクチャ概要

```text
main Claude agent
  └─ Bash: quarantine-fetch-codex.sh "<url>"
       │
       │  パイプ内部:
       │  ┌────────────────────────────────────┐
       │  │ 隔離プロセス (codex --search exec) │
       │  │  Web取得 → 最終JSONメッセージ      │
       │  └──────────┬─────────────────────────┘
       │             │ stdout (JSONL events)
       │             ▼
       │  ┌────────────────────────────────────┐
       │  │ pipe-sanitize-codex.ts            │
       │  │  agent_message抽出 → sanitize()   │
       │  └──────────┬─────────────────────────┘
       │             │ stdout (サニタイズ済みJSON)
       ▼
  main Claude agent のコンテキスト: サニタイズ済みテキスト + flags のみ
```

この skill はインジェクション対策の **緩和策** であり、完全防御ではない。特に Codex 子のツール権限を Claude 版ほど厳密に制約できない点は重要な差分である。

## 2. 脅威モデル

想定する攻撃:

- **不可視 Unicode 攻撃**: Tag characters (U+E0000-U+E007F)、zero-width 文字、bidi オーバーライドを使った不可視命令の埋め込み
- **LLM チャットテンプレート擬装**: `<|im_start|>`, `</untrusted_content>`, `[INST]`, `Human:` などのマーカーで役割境界の脱出を試みる
- **間接的指示注入**: "ignore previous instructions", "you are now", "new instructions:" などのパターン
- **JSON 出力偽装**: 子 Codex が最終メッセージで schema に見合うが悪意あるペイロードを返す試み
- **URL 改竄**: 要求した URL と異なるオリジンのコンテンツを返し、親に別サイトの内容を誤認させる試み
- **ツール権限の横滑り**: Codex 子が Web 取得以外の手段を使おうとするリスク
- **`[FILTERED]` / `[ESCAPED:]` マーカーの悪用**: sanitize.ts の付与マーカーとの区別を曖昧にする試み

想定しない攻撃:

- モデル重み自体への攻撃
- 自然言語で巧妙に埋め込まれた高度なソーシャルエンジニアリング
- 親 Claude がスキルをバイパスして直接 Web コンテンツを読む運用ミス

## 3. トリガー条件

以下のいずれかに該当するとき発火させる。

- ユーザーが URL を提示し、その内容取得・要約・分析を要求した
- 親を Claude に保ったまま、子 fetcher として Codex を使いたい
- Web コンテンツを Claude 親のコンテキストに直接入れたくない

以下の場合は本スキルの対象外とする。

- Web 検索クエリの実行が主目的である場合
- Claude 子の `WebFetch` で十分な場合

ローカルファイルについては、保存場所ではなく出所で判断する。外部由来の HTML / Markdown / テキストをローカル保存してから読む場合も、本質的には同じ脅威モデルを持つ。

## 4. 動作環境と制約

前提条件:

- Node.js 23.6 以降
- `codex` CLI がインストール済みであること
- Codex がログイン済みであること
- `codex --search exec` が利用可能であること

Codex 版の重要な制約:

- `codex exec` には Claude 版の `--allowedTools "WebFetch"` に相当する細粒度のツール固定が見えていない
- `--search` は親 `codex` コマンドに付与し、`exec` サブコマンドに Web 取得能力を渡す必要がある
- `--output-schema` は Claude 版の JSON Schema より厳格で、`properties` にあるキーをすべて `required` に含める必要がある
- 環境によっては read-only sandbox で Codex セッション初期化が失敗するため、限定的な `workspace-write` フォールバックが必要になる

## 5. ディレクトリ構成

```text
guarded-webfetch-codex/
├── SKILL.md
├── references/
│   ├── design-plan.md
│   └── fetch-output-schema.json
└── scripts/
    ├── quarantine-fetch-codex.sh
    ├── pipe-sanitize-codex.ts
    └── sanitize.ts
```

- `sanitize.ts` は `guarded-webfetch-claude` の実装を re-export して共有する
- 一時ファイルや隔離用 cwd は `.temp/guarded-webfetch-codex/` を使う

## 6. 実行フロー

### ステップ 1: URL の特定

- 明示的な URL をそのまま使う
- 複数 URL は URL ごとに個別処理する
- 並列処理は最大 5 件までとする

### ステップ 2: fetch + sanitize

各 URL に対して次を実行する。

```bash
.claude/skills/guarded-webfetch-codex/scripts/quarantine-fetch-codex.sh '<対象URL>'
```

`quarantine-fetch-codex.sh` は以下を行う。

1. Node.js と `codex` CLI の存在確認
2. `.temp/guarded-webfetch-codex/` を隔離用 cwd として作成
3. `codex --search exec --sandbox read-only --ephemeral --json --output-schema ...` を試行
4. read-only で `Failed to create session` や `Read-only file system` が出た場合のみ、`--sandbox workspace-write --add-dir "$QUARANTINE_CWD"` にフォールバック
5. Codex の JSONL 出力を `pipe-sanitize-codex.ts` にパイプ

Codex 子に与えるプロンプトでは次を要求する。

- 対象 URL の本文テキスト取得
- 可能なら Web 検索・Web 閲覧能力だけで完結すること
- 不要なシェル実行を行わないこと
- `raw_text` は可能な限り原文を保つこと
- 50,000 文字超は先頭 50,000 文字に切り詰めること
- 最終出力は JSON オブジェクトのみとすること

### ステップ 3: JSONL 抽出とサニタイズ

`pipe-sanitize-codex.ts` は以下を行う。

1. CLI 引数の URL を検証（`http://` または `https://` のみ許可）
2. stdin から Codex の JSONL イベント列を読む
3. `type === "item.completed"` かつ `item.type === "agent_message"` の最終イベントを抽出
4. `item.text` を JSON として parse し、`url`, `raw_text`, `fetch_success`, `error_message` を検証
5. `fetch_success === false` なら fail-closed で終了
6. CLI 引数の URL と取得 URL のオリジンを比較し、不一致なら fail-closed で終了
7. `sanitize(requestedUrl, fetchedUrl, rawText)` を実行し、`SanitizedDoc` JSON を stdout に出力

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

`sanitize.ts` は Claude 版と同じ実装を共有する。対象は Codex 子が返した本文テキストであり、以下の 2 層に特化する。

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

| 項目       | 値                                             | 制約の強度 |
| ---------- | ---------------------------------------------- | ---------- |
| 親コマンド | `codex --search exec`                          | 準ハード   |
| sandbox    | `read-only` 優先、必要時のみ `workspace-write` | ハード     |
| 永続化     | `--ephemeral`                                  | ハード     |
| 出力形式   | `--json`                                       | ハード     |
| schema     | `--output-schema fetch-output-schema.json`     | ハード     |
| cwd        | `-C "$QUARANTINE_CWD"`                         | ハード     |

### 出力スキーマ（`fetch-output-schema.json`）

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

- `error_message` を省略可能にせず常に required にするのは Codex 側 schema 制約に合わせるため
- `raw_text` の `maxLength` は schema に持たせず、sanitize.ts の truncation に一本化する

### `quarantine-fetch-codex.sh`

このスクリプトは read-only を第一候補にする。

- **狙い**: Web 取得だけなら書き込み不要と考え、最小権限で通す
- **例外**: Codex セッション初期化が read-only で失敗する環境では、`.temp/guarded-webfetch-codex/` 限定の `workspace-write` に落とす
- **フォールバック条件**: stderr に `read-only file system`, `failed to create session`, `os error 30` が含まれる場合

### `pipe-sanitize-codex.ts`

Codex 出力が Claude 版と異なり JSONL イベント列であることが最大の差分である。したがって sanitize 前に次の抽出層が必要になる。

- 行ごとに JSON parse を試みる
- `item.completed` / `agent_message` の最終メッセージだけを採用する
- `error` イベントしかない場合は fail-closed
- 最終メッセージが JSON でない場合も fail-closed

## 9. テストケース

最低限確認すべきケース:

1. **正常系**: `https://example.com` を取得し、サニタイズ済み JSON が返る
2. **マーカー検出**: `raw_text` に `<|im_start|>` を含む JSONL を `pipe-sanitize-codex.ts` に与え、`[FILTERED:chat_template]` に置換される
3. **error イベントのみ**: Codex JSONL に `type: "error"` しかない場合、fail-closed で終了する
4. **fetch_success=false**: 最終メッセージで失敗応答を返した場合、親へ通さずエラー終了する
5. **オリジン不一致**: 要求 URL と取得 URL のオリジンが異なる場合に停止する
6. **read-only 失敗**: read-only 初期化失敗時のみ `workspace-write` にフォールバックする
7. **巨大テキスト**: 50,000 文字超で `truncated: true` が立つ

テストは `pipe-sanitize-codex.ts` の in-source testing と、`quarantine-fetch-codex.sh` の手動 E2E で行う。

## 10. 設計上の割り切り

- **Codex 子のツール権限を厳密には縛れない**: Claude 版の `WebFetch only` 相当の強制が見えていない。プロンプトと sandbox で抑制するが、完全なハード制約ではない
- **read-only が常に通るとは限らない**: 環境によっては Codex セッション生成自体が書き込みを要求する。そのため最小権限を保ちつつ実用性を確保する目的で、限定的な `workspace-write` フォールバックを持つ
- **Codex の Web 取得内容はモデル判断を通る**: `raw_text` は Codex 子が最終メッセージとして返すため、完全な「生 HTML 直出し」ではない。取得と整形の間にモデル判断が入る
- **main Claude はサニタイズ済み全文を見る**: 自然言語ベースの説得・誘導までは静的サニタイザでは防げない
- **JSONL フォーマット依存**: `pipe-sanitize-codex.ts` は現在観測した Codex イベント形式に依存する。CLI 側のイベント schema 変更には追随が必要
- **完全防御ではない**: 要確認時に親 Claude が出力を抑制する運用が前提

## 11. 将来的な拡張候補

- **Codex 側の finer-grained tool permission 対応**: `Web only` や `no shell` を CLI オプションで明示できるようになれば、隔離強度を上げられる
- **Codex JSONL parser の厳密化**: イベント schema を型定義や JSON Schema として固定し、CLI 変更検知をしやすくする
- **guarded-websearch-codex**: 検索結果一覧向けに同じ構造を展開する
- **二段隔離**: Codex 子を取得専用、別プロセスを要約専用に分離する
- **より厳密な権限評価**: `read-only` 失敗理由を分類し、フォールバック条件をより限定する

## 12. 参考資料

- `guarded-webfetch-claude/references/design-plan.md`
- Codex CLI `codex exec --help`
- Codex CLI `codex --help`
- AWS "Defending LLM applications against Unicode character smuggling"
- Promptfoo "The Invisible Threat: Zero-Width Unicode Characters"
