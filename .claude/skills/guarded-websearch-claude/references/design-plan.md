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

防御層の構成 (ハード制約 / ソフト制約) も guarded-webfetch-claude と同一の 3 層を採用する。詳細は guarded-webfetch-claude の design-plan.md セクション 1 を参照。

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

### スキルを分ける理由

WebFetch（個別 URL のコンテンツ取得）と WebSearch（検索クエリの実行）は同じ「外部コンテンツをコンテキストに取り込む」目的を持つが、以下の点で構造が異なるため別スキルとして実装する:

1. **隔離プロセスの構成が異なる**: WebFetch は `--tools "WebFetch"` で単一 URL のコンテンツを取得するが、WebSearch は `--tools "WebSearch"` で検索クエリを実行し複数の結果を返す。ツール制限・settings・出力スキーマがすべて異なるため、単一スキル内で両ツールを切り替える設計よりも、それぞれの責務に専念したスキルとして分けた方が実装と監査が単純になる
2. **出力構造が異なる**: WebFetch は単一の raw_text を返すが、WebSearch は複数の title/snippet/url の配列を返す。サニタイズ後の判定軸（webfetch は単一 flags、websearch は個別 + aggregate の二層）も異なるため、パイプスクリプトのロジックを共有するメリットが乏しい
3. **トリガー条件の明確化**: 「URL を指定してコンテンツを取得する」と「検索クエリを実行する」は意味的に異なる操作であり、SKILL.md の description でトリガー条件を分離することで発火精度が向上する。ユーザーが URL を貼った場合と「○○について調べて」と言った場合で、別々の skill description が独立にマッチする方が undertrigger も overtrigger も避けやすい

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
- **検索結果の URL スキーム偽装**: 結果の URL に `javascript:`, `file:`, `data:` 等の非 web スキームを混入させ、main agent / ユーザーの誤クリックを誘発する
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

`--bare` を使用しない理由および環境変数の選定意図は guarded-webfetch-claude の design-plan.md セクション 4 を参照。本スキルでも同一方針を採用する。

### 環境変数による隔離強化

guarded-webfetch-claude と同一の環境変数を設定する:

| 環境変数                                  | 値      | 効果                               |
| ----------------------------------------- | ------- | ---------------------------------- |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS`          | `1`     | CLAUDE.md の自動読込を無効化       |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`        | `1`     | 認証情報のスクラブ                 |
| `ENABLE_CLAUDEAI_MCP_SERVERS`             | `false` | claude.ai MCP サーバーを無効化     |
| `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` | `1`     | ビルトインサブエージェントを無効化 |
| `CLAUDE_CODE_SKIP_PROMPT_HISTORY`         | `1`     | セッション履歴の書き込みを無効化   |

### 隔離プロセスの cwd を `.temp/guarded-websearch-claude/` に切り替える根拠

`quarantine-search.sh` は `claude -p` をサブシェル内で `cd "$PWD/.temp/guarded-websearch-claude" && ...` として起動する。理由は guarded-webfetch-claude と同一（auto-discovery 抑止と `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` の副作用ファイル群の隔離）。詳細な副作用ファイル一覧は guarded-webfetch-claude の design-plan.md セクション 4 を参照。

`.temp/guarded-webfetch-claude/` ではなく `.temp/guarded-websearch-claude/` を使うのは、両スキルを並行起動した際にディレクトリが衝突しないようにするため。

### permission 評価順序

guarded-webfetch-claude と同様、Claude Code の permission 評価順序は **deny → ask → allow** であり deny が優先される。本スキルの隔離プロセスでも Bash を使用しないため `deny` に含めて問題ない。

## 6. ディレクトリ構成

```
guarded-websearch-claude/
├── SKILL.md
├── scripts/
│   ├── check-node-version.sh     # ステップ 0 で main agent が呼ぶ Node.js 23.6+ 事前チェック
│   ├── quarantine-search.sh      # 隔離環境変数・cwd 切替・claude -p 起動・サニタイザ起動を集約
│   ├── sanitize.ts               # guarded-webfetch-claude の sanitize.ts を re-export
│   └── pipe-sanitize-search.ts   # 隔離プロセス出力→sanitize→stdout パイプスクリプト
└── references/
    ├── design-plan.md             # このドキュメント
    ├── search-output-schema.json  # 隔離プロセス用 --json-schema
    ├── quarantine-search-settings.json  # 隔離プロセス用 permission 設定
    └── injection_patterns.md      # guarded-webfetch-claude のパターン集を共有参照
```

sanitize.ts は guarded-webfetch-claude 側で一元管理し、本スキルは re-export 経由で import する（詳細はセクション 2 参照）。`injection_patterns.md` も同様に guarded-webfetch-claude 側を一次ソースとし、本スキル側は参照リンクのみを持つ。

## 7. 実行フロー

**ステップ 0: 前提条件チェック（最初に必ず実行）**

```bash
.claude/skills/guarded-websearch-claude/scripts/check-node-version.sh
```

このチェックは SKILL.md のステップ 0 として main agent が Bash ツールで実行する。23.6 未満の場合はスクリプトが exit code 3 で終了するので、ユーザーに以下を伝えて中止:

> この skill は Node.js 23.6 以降を必要とします（TypeScript を追加ツールなしで直接実行するため）。現在の Node バージョンは `<取得したバージョン>` です。`nvm install --lts` 等で新しいバージョンをインストールしてから再度お試しください。

`<取得したバージョン>` には `check-node-version.sh` が stderr に出力する `(現在: vXX.YY.Z)` 部分の値を埋める。`scripts/quarantine-search.sh` も冒頭で同じバージョンチェックを行う。これは多層防御として残しており、main agent が事前チェックを省いた場合でも search 実行前に必ず止まる。

**ステップ 1: 検索クエリの特定**

ユーザー要求から検索クエリを特定する。

**ステップ 2: search + sanitize（パイプ接続）**

`quarantine-search.sh` を呼び出す。env vars / cwd 切替 / `claude -p` / `pipe-sanitize-search.ts` の接続・レートリミットリトライまでをスクリプトに集約している。

```bash
.claude/skills/guarded-websearch-claude/scripts/quarantine-search.sh '<検索クエリ>'
```

> **シェルインジェクション防止 (多層防御)**: クエリは `'...'` で囲んで bash に渡す（main agent のソフト判断）。一方、`quarantine-search.sh` の入口で禁止文字検証（`` ` ``、`$(`、制御文字）と長さ上限 1000 字を行い、不正なクエリは API コスト発生前に exit code 2 で弾く（ハード制約）。bash の heredoc (sigil 無し) では変数値の中身は再評価されないため `$()`/バッククォートのコマンド置換は発生しないが、プロンプト整形の崩れや将来の実装変更で injection 経路となる余地を一律塞ぐため fail-closed で拒否する。プロンプト整形は LLM がどこまでをクエリとみなすかの曖昧さを避けるため、クエリを引用符で囲わず独立した行に配置する形式（`QUERY:\n${QUERY}`）に統一している。

`quarantine-search.sh` は内部で次を実行する:

1. Node.js バージョンチェック（exit code 3）
2. クエリの入口検証: 空文字 / バッククォート / `$()` / 制御文字 / 1000 字超 を fail-closed で拒否（exit code 2）
3. cwd を `.temp/guarded-websearch-claude/` に切り替えて隔離環境変数 (セクション 5) を設定し、`claude -p --tools "WebSearch" ... --json-schema search-output-schema.json --max-turns 3` を起動
4. 隔離プロセスの stderr が `rate.?limit` / `429` / `too many requests` / `overloaded` のいずれかを含む場合、10 秒待機後に 1 回だけ再試行（レートリミット以外のエラーはリトライせず exit code 1）
5. 成功時は stdout の JSON を `node pipe-sanitize-search.ts '<検索クエリ>'` にパイプで接続

`pipe-sanitize-search.ts` は以下を行う:

1. CLI 引数のクエリを**必須として**検証（未指定は fail-closed で exit code 1、長さは 1000 字上限）。CLI クエリ未指定時に隔離プロセス出力の `query` を fallback で使うと untrusted な値が出力に流入するため、深層防御として CLI クエリを必須化する
2. stdin から `claude -p --output-format json` の出力 JSON を読む
3. `subtype === "success"` と `structured_output.results` の存在を検証
4. 各検索結果の URL スキームを検証し、`http:` / `https:` 以外（`javascript:`, `file:`, `data:` 等）を持つ結果は除外。除外件数は `aggregate_flags.filtered_unsafe_urls` に記録
5. 残った結果の `title` と `snippet` に対して sanitize.ts の `sanitize()` 関数を呼ぶ
6. 個別結果の `title_flags` / `snippet_flags` と全体集約の `aggregate_flags` を含む JSON を stdout に出力
7. 検証失敗時は stderr にエラーを出力し exit code 1 で終了

> **CLI 引数のクエリの役割と限界**: pipe-sanitize-search.ts は CLI 引数のクエリを出力の `query` フィールドに使用し、表示上のクエリがユーザーの意図と一致することを保証する。ただし、これは隔離プロセスが実際に実行した検索クエリを検証するものではない。隔離プロセスが別のクエリで検索した場合、結果は別のクエリのものであっても出力の `query` フィールドだけが CLI 引数の値になる。これは既知の限界であり、隔離プロセスの制約（`--tools "WebSearch"`, `--max-turns 3`, スキーマ強制）が実質的な防御線となる。webfetch ではオリジン比較で `requested_url` ↔ `fetched_url` の整合を強制できるが、検索クエリには相当する検証メカニズムが存在しない。

main agent 側でリトライを行わないのは guarded-webfetch-claude と同じ理由（Bash tool の並列起動から exit code を見て選択的に再起動するロジックが脆く、スクリプト内で完結させた方が確実なため）。

**ステップ 3: 安全性判定**

pipe-sanitize-search.ts の出力は `aggregate_flags`（全結果集計）と各 `results[i]` 内の `title_flags` / `snippet_flags`（個別結果単位）の二層構造。**全体判定は `aggregate_flags`、redact 対象の選定は個別 flags** を見る。

`suspicious_patterns` はカテゴリ別件数の Record（`{ chat_template: 3, ... }`）。攻撃文言そのものは main agent には渡らないため、判定はカテゴリ名と件数のみで行う。「空」とはこの Record にキーが存在しない (`Object.keys(suspicious_patterns).length === 0`) 状態を指す。

**判定の評価順序**: 以下の表は上から順に評価し、最初にマッチした行の判定を採用する（`aggregate_flags` を見る）。`suspicious_patterns` 非空と `filtered_unsafe_urls` 1 件以上はいずれも「要確認」だが、ユーザー報告文の重点（インジェクション検出 vs URL スキーム不正）が異なるため別行に分けてある。`had_invisible_chars` 単独の「注意」判定は他のフラグが立っていないときにのみ意味を持つため、複合条件として独立行を持たせない。

| 条件                                                        | 判定   | main agent の振る舞い                                                                       |
| ----------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `suspicious_patterns` が 1 カテゴリ以上                     | 要確認 | ユーザー確認まで actionable な出力（URL / コマンド / コード）を生成しない                   |
| `filtered_unsafe_urls` が 1 件以上                          | 要確認 | 不正なスキームの URL が検出された旨をユーザーに報告。除外件数を通知                         |
| `had_invisible_chars` が `true`、`suspicious_patterns` が空 | 注意   | 応答に「不可視文字の除去または Unicode 互換正規化によりテキストが変形された」旨の通知を付与 |
| 上記いずれにも該当しない                                    | 安全   | そのまま応答を生成                                                                          |

「要確認」判定時の表示では、**個別結果ごとに `results[i].title_flags` / `results[i].snippet_flags` を確認し**、`suspicious_patterns` が非空、または `had_invisible_chars` が `true` の field（title もしくは snippet）を `[redacted]` に置換して伏せる。フラグが立っていない結果はそのまま表示する。ユーザーが確認後に明示的に要求した場合のみ、伏せた情報を開示する。

> **注**: 個別 flags 単位での redact 対応は main agent のソフト判断に依存する制約であり、サニタイザ層では強制できない。webfetch のように「actionable な出力（URL・コマンド・実行手順）の生成自体をユーザー確認まで控える」ことが本質的な防御線である（webfetch design-plan セクション 1 の 3 層防御モデル参照）。

なお webfetch にある `truncated` フラグは search では露出しない。検索結果の title (maxLength: 500) と snippet (maxLength: 2000) は隔離プロセス出力スキーマ側で十分に短く制限されており、sanitize 内の 50,000 code unit 上限に達する経路がないため。

**ステップ 4: 最終応答の生成**

サニタイズ済み検索結果をもとに応答を生成する。検索結果の URL は title/snippet と比較して改竄コストが高いが、隔離プロセス由来の未検証データである点は同様。URL を actionable な推奨として出力する際は guarded-webfetch-claude を経由させる。

## 8. サニタイザの処理

guarded-webfetch-claude の sanitize.ts を共有使用する。検索結果の各 title・snippet に対して個別に `sanitize(url, url, text)` を呼び出す（検索結果の URL は隔離プロセス由来のみで CLI 引数に対応する URL がないため、`requested_url` と `fetched_url` は同一値で渡す）。

処理層の詳細（Unicode 層・LLM マーカー無害化・量的制限）は guarded-webfetch-claude の design-plan.md セクション 7 を参照。

### 検索結果固有の考慮事項

- title・snippet は比較的短いテキスト（数百〜数千文字）であるため、50,000 文字の truncate 制限に達することはまずない
- 検索結果ごとに個別に flags（`title_flags`, `snippet_flags`）が記録されるため、どの結果のどの field に問題があるかを特定できる
- `aggregate_flags` で全結果のフラグを集約し、安全性判定の入力とする
- URL スキーム検証で除外された件数は `aggregate_flags.filtered_unsafe_urls` に記録される（個別の flags ではなく集約のみに記録）

### `truncated` フラグを `aggregate_flags` に集約しない理由

`SanitizeFlags` 型（webfetch と共有）は `truncated: boolean` を持つが、本スキルの `aggregate_flags` には集約していない。これは以下の二段の制約により、検索結果の title/snippet で `truncated: true` が立つ経路が実質的に存在しないため:

1. **JSON Schema による上限**: `search-output-schema.json` で `title.maxLength: 500` / `snippet.maxLength: 2000` を強制している。隔離プロセスのモデルがこれを超える文字列を返した場合、`claude -p --json-schema` の検証で `subtype` が失敗系に分岐し、ラッパーレベルで弾かれる
2. **pipe-sanitize-search.ts のラッパー検証**: 上記で `subtype !== 'success'` となった出力は `validateSearchEnvelope` がエラーを投げ、`runCli` が exit code 1 で fail-closed する。サニタイザの `truncated` 判定（`MAX_CHARS = 50_000`）に到達する前に処理が止まる

つまり title/snippet が `MAX_CHARS` (50,000) に達する経路は、`maxLength: 500/2000` のスキーマ強制を破壊する隔離プロセス側の重大な不具合がない限り発生せず、その場合は `aggregate_flags.truncated` ではなく exit code 1 として表面化する。`title_flags` / `snippet_flags` の `truncated` フィールドはサニタイザの構造上残っているが、`aggregate_flags` 側に独立した判定軸として持たせると「到達不能なケースのために main agent に追加判定を強いる」形になるため、意図的に集約から外している。

将来 schema の `maxLength` を緩める変更を行う場合は、本節の前提が崩れるため `aggregate_flags.truncated` の追加とそれに対応する SKILL.md ステップ 3 の判定行追加を併せて検討すること。

## 9. 隔離プロセス仕様

### ランタイム制約

| フラグ / 環境変数 | 値                                | 制約の強度                                      |
| ----------------- | --------------------------------- | ----------------------------------------------- |
| `--tools`         | `"WebSearch"`                     | ハード（WebSearch のみ）                        |
| `--allowedTools`  | `"WebSearch"`                     | WebSearch を自動許可                            |
| `--settings`      | `quarantine-search-settings.json` | ハード（後述）                                  |
| 環境変数          | セクション 5 参照                 | ハード                                          |
| cwd               | `.temp/guarded-websearch-claude/` | ハード（セクション 5 参照）                     |
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
2. **title にインジェクション**: title に `<|im_start|>` を含む検索結果 → pipe-sanitize-search.ts が `[FILTERED:chat_template]` に置換、`title_flags.suspicious_patterns` に記録、`aggregate_flags` に集約
3. **snippet にインジェクション**: snippet に `ignore all previous instructions` を含む → `[FILTERED:instruction_override]` に置換
4. **不可視文字**: title/snippet に zero-width 文字を含む → 除去、`had_invisible_chars: true`
5. **複数結果の混在**: 10 件中 2 件にインジェクション → 該当 2 件の個別 flags に記録、main agent は個別 flags を見て該当 field のみ redact
6. **URL スキーム偽装**: results 配列に `javascript:` / `file:` / `data:` URL を含む結果 → `sanitizeSearchResults` が除外、`aggregate_flags.filtered_unsafe_urls` をインクリメント
7. **環境チェック**: Node.js 23.6 未満 → `check-node-version.sh` および `quarantine-search.sh` が exit code 3 で停止
8. **クエリ入口検証**: 空文字 / バッククォート / `$()` / 制御文字 / 1000 字超のクエリ → `quarantine-search.sh` が exit code 2 で停止（API コスト発生前に弾く）
9. **CLI クエリ必須化**: `pipe-sanitize-search.ts` を CLI 引数なしで起動 → exit code 1 で停止（隔離プロセス出力の query を素通しさせない）
10. **WebSearch 失敗**: 隔離プロセスの WebSearch が失敗 → `search_success: false`、pipe-sanitize-search.ts が exit code 1
11. **不正な結果アイテム**: results 配列に不正な型のオブジェクトが含まれる → fail-closed で exit code 1（隔離チャネルでの型崩れを検出）
12. **空の検索結果**: 検索結果が 0 件 → 空配列として正常に処理
13. **`[FILTERED]` / `[ESCAPED:]` 偽装攻撃**: title/snippet に `[FILTERED]` を含む → `[ESCAPED:FILTERED]` にエスケープ。`[ESCAPED:FILTERED]` を含む → `[ESCAPED:ESCAPED:FILTERED]` に再帰エスケープ。共有 sanitize.ts の挙動と同じ観点で確認する
14. **レートリミットリトライ**: `claude -p` が 429 / overloaded を返す → `quarantine-search.sh` が 10 秒待機後に 1 回再試行。再試行も失敗時は exit code 1
15. **`suspicious_patterns` 検出時の安全性判定**: 1 件以上の suspicious_patterns → main agent がユーザー確認を取るまで actionable な出力を生成しない

テストは pipe-sanitize-search.ts の単体テストとして自動化する（Vitest の in-source testing 機能を使用）。`quarantine-search.sh` の入口検証はシェル単位で動作確認する。E2E テスト（隔離プロセスを含む統合テスト）は手動で実施する。

## 11. 設計上の割り切り

- **sanitize.ts の import 依存**: sanitize.ts は guarded-webfetch-claude 側で一元管理し、本スキルは re-export 経由で import する。パターン更新の同期漏れは防げるが、本スキルは guarded-webfetch-claude が同一リポジトリ内に存在しないと動作しない（独立性のトレードオフ）。単独配布時は re-export を実体のコピーに差し替える必要がある
- **検索結果の URL はスキーム検証済みで通す**: `sanitizeSearchResults()` で各結果の URL スキームを検証し、`http:` / `https:` 以外のスキーム（`javascript:`, `file:`, `data:` 等）を持つ結果は除外する。除外件数は `aggregate_flags.filtered_unsafe_urls` に記録される。URL の内容自体のサニタイズは対象外だが、URL を actionable な推奨として出力する際は guarded-webfetch-claude を経由させる
- **SEO ポイズニングは対象外**: 悪意ある URL が検索上位に表示されることによる誘導は、検索エンジン側の問題であり本スキルの対象外
- **検索クエリの改竄は検証不能**: CLI 引数のクエリ上書きは出力の `query` フィールドの表示を保証するだけであり、隔離プロセスが実際に実行した検索クエリを検証する手段はない。webfetch のオリジン比較に相当する検証メカニズムが検索クエリには存在しないため、隔離プロセスの制約（`--tools "WebSearch"`, `--max-turns 3`, スキーマ強制）が実質的な防御線となる
- **クエリのシェルインジェクション防止は多層**: main agent → `quarantine-search.sh` の呼び出しでクエリを `'...'` で囲むのは main agent のソフト判断に依存する。一方、`quarantine-search.sh` の入口で禁止文字検証（`` ` ``、`$(`、制御文字）と長さ上限 1000 字を行い、不正なクエリは API コスト発生前に exit code 2 で弾く（ハード制約）。bash の heredoc (sigil 無し) では変数値の中身は再評価されないため `$()`/バッククォートのコマンド置換は発生しないが、プロンプト整形の崩れや将来の実装変更で injection 経路となる余地を一律塞ぐため fail-closed で拒否する。プロンプト整形は LLM がどこまでをクエリとみなすかの曖昧さを避けるため、クエリを引用符で囲わず独立した行に配置する形式（`QUERY:\n${QUERY}`）に統一している
- **CLI クエリ必須化による fail-closed**: `pipe-sanitize-search.ts` は CLI 引数のクエリ未指定時に隔離プロセス出力の `query` を fallback として採用しない。webfetch の cliUrl 必須化と同じ深層防御の方針に揃え、untrusted な値が出力に素通りする経路を塞ぐ
- **個別 flags と aggregate flags の二層構造**: 検索結果は複数件あるため、個別の `title_flags` / `snippet_flags` と全体集約の `aggregate_flags` の二層を出力する。main agent は判定に aggregate を、redact 対象選定に個別を見る。これは webfetch には存在しない構造（webfetch は単一 URL のため）
- **隔離プロセスの stderr が main agent に流れる経路は残る**: `quarantine-search.sh` は失敗時に隔離プロセスの stderr を `cat ... >&2` でそのまま親に流す。通常は `claude -p` 自体が出すシステム的なエラー文（ネットワーク失敗・レートリミット通知等）であり、隔離プロセスのモデル出力は `--output-format json` の stdout 側に整形されるため、サニタイザを経由せずに main agent に届くのは主に CLI レイヤのメッセージである。ただしランタイムの仕様変更や巧妙な入力で stderr 側に攻撃ペイロードが現れる可能性は完全には排除できない。リスクは低いが、stderr 経路はサニタイザを通っていない点を割り切りとして明示する
- **完全防御ではない**: guarded-webfetch-claude と同様の緩和策
- **WebSearch の返却形式への依存**: WebSearch ツールの返却形式が変更された場合、隔離プロセスのプロンプトと出力スキーマの更新が必要
- **パターンリストは guarded-webfetch-claude 側と同期**: LLM マーカーのパターンリストは guarded-webfetch-claude の `references/injection_patterns.md` と sanitize.ts に一元管理されている。新しい攻撃手法が公開された場合の更新も guarded-webfetch-claude 側で行えば本スキルにも自動的に反映される

## 12. 将来的な拡張候補

- **検索結果のクロスバリデーション**: 複数の検索エンジンの結果を比較し、一致しない結果を疑わしいとしてフラグする
- **URL レピュテーションチェック**: 既知の悪意あるドメインリストとの照合
- **guarded-webfetch-claude との統合ワークフロー**: 検索 → URL 選定 → コンテンツ取得の一連のフローを自動化するメタスキル

## 13. 参考資料

- guarded-webfetch-claude の design-plan.md: 基盤となる設計・脅威モデル・参考文献（本ドキュメントから多数のセクションを参照）
- Simon Willison "Dual LLM pattern" -- https://simonwillison.net/2023/Apr/25/dual-llm-pattern/
- Google DeepMind CaMeL -- https://arxiv.org/abs/2503.18813
