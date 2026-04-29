# guarded-webfetch-claude 設計計画

このドキュメントは `guarded-webfetch-claude` skill の設計意図・構成・割り切りを記録するためのものである。skill の `references/design-plan.md` として配置し、将来の改修・移植・監査時の参照資料とする。

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

指定された URL のコンテンツ（WebFetch によるページ取得）を Claude が取り扱う際、プロンプトインジェクション攻撃を抑制するためのガード層を提供する。Web 検索（WebSearch）については guarded-websearch-claude が担当する。

設計の核は **「untrusted content と特権的判断・ツール実行の論理的分離」**。隔離プロセスとプロセス間パイプにより、生の Web コンテンツが main agent のコンテキストに入ることを防ぐ。

ただし、防御層には **ハード制約** と **ソフト制約** がある。ハード制約は CLI フラグや JSON Schema 検証のようにランタイムで強制されるもの、ソフト制約はプロセスへの指示や運用で守らせるものを指す。本設計では次の 3 層を採用する:

1. **WebFetch (標準ツール, ハード)** — Claude Code 標準の WebFetch ツール経由でコンテンツを取得。Anthropic サーバー側のドメイン安全チェック・HTML→テキスト変換・プロンプトインジェクション対策が適用される。隔離プロセス（fetch 専用）内で実行する
2. **静的サニタイザ (TypeScript, ハード)** — 隔離プロセスの出力をパイプで `pipe-sanitize.ts` に接続し、Unicode 不可視文字の除去と LLM マーカーの無害化を**プロセス間パイプとしてランタイム強制**する。LLM を経由しない決定論的スクリプト
3. **安全性フラグによる行動制御 (ソフト)** — sanitize.ts が検出した `suspicious_patterns` や `had_invisible_chars` 等のフラグに基づき、main agent が安全性判定を行う。フラグの閾値ルールは SKILL.md に記述し、main agent が遵守する

### アーキテクチャ概要

```
main agent
  └─ Bash: claude -p [fetch] | pipe-sanitize.ts "<url>"
       │
       │  パイプ内部:
       │  ┌─────────────────────────────────────┐
       │  │ 隔離プロセス (claude -p, WebFetch のみ)│
       │  │  WebFetch → 生テキスト → raw_text     │
       │  └──────────┬──────────────────────────┘
       │             │ stdout (JSON: raw_text含む)
       │             ▼
       │  ┌─────────────────────────────────────┐
       │  │ pipe-sanitize.ts (決定論的スクリプト)  │
       │  │  raw_text抽出 → sanitize() → 出力     │
       │  └──────────┬──────────────────────────┘
       │             │ stdout (サニタイズ済みJSON)
       ▼
  main agent のコンテキスト: サニタイズ済みテキスト + flags のみ
       │
       ├─ flags に基づく安全性判定
       └─ サニタイズ済みテキストを分析し最終応答を生成
```

main agent は信頼されたエージェントであり、サニタイズ済みテキストに基づいて分析・応答を行う。生テキストはパイプ内で完結し、main agent のコンテキストには入らない。

この skill はインジェクション対策の **緩和策** であり、完全防御ではない。

## 2. 脅威モデル

想定する攻撃:

- **不可視 Unicode 攻撃**: Tag characters (U+E0000-U+E007F)、zero-width 文字、bidi オーバーライドを使った不可視命令の埋め込み。人間には見えないが LLM はトークンレベルで処理する
- **HTML 構造を使った隠蔽**: HTML コメント、`<script>` / `<style>` 内テキスト、`display:none` / `visibility:hidden` / `opacity:0` などの不可視 CSS 要素。WebFetch の HTML→テキスト変換で大部分が除去されるが、変換ロジックの詳細は非公開のため完全な保証はない
- **LLM チャットテンプレート擬装**: `<|im_start|>`, `</untrusted_content>`, `[INST]`, `Human:` などのマーカーで隔離タグからの脱出を試みる
- **間接的指示注入**: "ignore previous instructions", "you are now", "new instructions:" などのパターン
- **exfiltration 試行**: 取得コンテンツ内の URL や画像タグ経由でのデータ漏洩誘導
- **`[FILTERED]` / `[ESCAPED:]` マーカーの悪用**: 攻撃テキスト内に `[FILTERED]` や `[ESCAPED:FILTERED]` を意図的に含め、sanitize.ts の出力と区別不能にする試み。また `[FILT` と `ERED]` のように分割して置換を回避する試み

想定しない(この skill では対応しない)攻撃:

- モデル重み自体への攻撃（Anthropic 側の責任）
- 正当に見える文章中に自然言語で埋め込まれた高度なソーシャルエンジニアリング（main agent の判断に依存）
- サンドボックス外のツール（bash など）を直接呼び出すユーザー要求

## 3. トリガー条件

以下のいずれかに該当するとき必ず発火させる:

- ユーザーが URL を提示して内容の取得・要約・分析を要求した
- `WebFetch` ツールを使う前
- 外部の HTML / Markdown / テキストコンテンツをコンテキストに取り込もうとしている
- 「このページ読んで」「このサイトまとめて」等の要求

以下の場合は **発火しない**（guarded-websearch-claude を使用する）:

- 「○○について調べて」「○○を検索して」等の Web 検索要求
- `WebSearch` ツールを使う前

skill の description は undertrigger を避けるためやや pushy に書く。

**ローカルファイルについて**: 信頼境界の基準は「保存場所」ではなく「出所（provenance）」である。外部サイト由来の HTML/Markdown をローカル保存してから読ませることで guard を迂回できるため、ローカルファイルであっても出所が外部の場合は本 skill の対象とする。ただし、ファイルの出所を自動追跡する仕組みは本 skill にはなく、発火判断は main agent のソフト判断に依存する（既知の限界）。

## 4. 動作環境と制約

- **Node.js v23.6 以降が必須**（type stripping がデフォルト有効なので `node .claude/skills/guarded-webfetch-claude/scripts/sanitize.ts` で直接実行できる）。skill 実行時に最初にバージョンチェックを行い、満たさなければユーザーに通知して中止する。フォールバックは提供しない
- **外部パッケージ依存ゼロ**（Node 標準 API のみ使用、`package.json` も不要、単体 `.ts` ファイルで配布）
- **Claude Code 前提**（`claude -p` による隔離プロセスを使うため）。SDK / claude.ai への移植は将来対応
- **認証は親プロセスの認証を継承**: `--bare` を使用しないため、Claude.ai ログイン済みの状態であれば追加の認証設定は不要
- **隔離プロセスのモデルは指定しない**: ユーザーの設定またはデフォルトモデルを使用する。settings ファイルに `model` フィールドは含めない

### `--bare` を使用しない理由

`--bare`（= `CLAUDE_CODE_SIMPLE=1`）は auto-discovery を包括的に無効化するが、同時に OAuth / keychain による認証も無効化するため `ANTHROPIC_API_KEY` が必須になる（実測で確認済み）。本設計では API キー不要で動作させるため `--bare` を使用せず、個別の環境変数で攻撃面を選択的に縮小する。hooks・skills・plugins の auto-discovery は残るが、`--tools` によるツール制限と `--settings` の permission 設定がランタイムで強制されるため、隔離の実効性は維持される。

なお `CLAUDE_CONFIG_DIR` で設定ディレクトリを空ディレクトリに変更すれば plugins 等の読み込みも防げるが、OAuth 認証情報も読めなくなるため採用しない（実測で確認済み）。

### 環境変数による隔離強化

隔離プロセス起動時に以下の環境変数を設定し、攻撃面を最小化する（すべて OAuth 認証に影響しないことを実測で確認済み）:

| 環境変数                                  | 値      | 効果                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS`          | `1`     | CLAUDE.md（ユーザー・プロジェクト・auto-memory）の自動読込を無効化。親プロジェクトの指示が隔離プロセスに注入されるのを防ぐ                                                                                                                                                                                                   |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`        | `1`     | Bash ツール・hooks・MCP stdio サーバーから認証情報をスクラブ。Linux では PID 名前空間で `/proc` 読み取り防止（macOS では `/proc` が存在しないためこの保護は不要。環境変数スクラブはクロスプラットフォームで機能する）。**副作用**: 起動時に cwd へ多数の空ファイル・空ディレクトリを生成する（次節「cwd 切替の根拠」を参照） |
| `ENABLE_CLAUDEAI_MCP_SERVERS`             | `false` | claude.ai MCP サーバー（Gmail, Calendar, Drive 等）を無効化。`--tools` で既にカバーされるが多層防御として設定                                                                                                                                                                                                                |
| `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` | `1`     | ビルトインサブエージェント（Explore, Plan 等）を無効化                                                                                                                                                                                                                                                                       |
| `CLAUDE_CODE_SKIP_PROMPT_HISTORY`         | `1`     | セッション履歴・トランスクリプトのディスク書き込みを無効化                                                                                                                                                                                                                                                                   |

### 隔離プロセスの cwd を `.temp/guarded-webfetch/` に切り替える根拠

`quarantine-fetch.sh` は `claude -p` をサブシェル内で `cd "$PWD/.temp/guarded-webfetch" && ...` として起動する。この cwd 切替は次の 2 つの目的を兼ねる:

1. **plugins / hooks / `.claude/` 設定の auto-discovery 抑止**: `claude -p` は cwd を起点に `.claude/` 配下や hooks をディスカバリするため、空ディレクトリで起動することで親プロジェクトの設定が隔離プロセスに混入するのを防ぐ。
2. **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` の副作用の隔離**: SCRUB 有効時、`claude -p` は起動時に cwd へ以下の空ファイル・空ディレクトリを生成する（実測で確認）:
   - 空ファイル (17 個): `.env`, `.env.development`, `.env.development.local`, `.env.local`, `.env.production`, `.env.production.local`, `.env.test`, `.env.test.local`, `.gitmodules`, `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `bunfig.toml`, `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`
   - 空ディレクトリ (5 個): `node_modules/`, `node_modules/.bin/`, `.claude/`, `.claude/agents/`, `.claude/commands/`

   これらは subprocess（Bash・hooks・MCP stdio）から認証情報を含む設定ファイルを読み出されないよう、空ファイルで先回りして「シャドーイング」する戦略の副作用とみられる。プロジェクト直下で隔離プロセスを起動するとこれらが既存ファイルを上書きしうるため、`.temp/guarded-webfetch/` に逃がす必要がある。

`mkdir -p "$quarantine_cwd"` でディレクトリを毎回確保し、副作用ファイル群がここにのみ累積するようにする。`.temp/` は AGENTS.md でエージェントの一時生成物の置き場として規定されており、`.gitignore` で除外する運用と整合する。

### permission 評価順序に関する注意

Claude Code の permission 評価順序は **deny → ask → allow** であり、**deny が常に優先される**。そのため `deny: ["Bash"]` と `allow: ["Bash(パターン)"]` を同時に設定すると、deny が先にマッチしてすべてブロックされる。本設計の隔離プロセスでは Bash を使用しないため `deny` に含めて問題ない（実測で確認済み）。

## 5. ディレクトリ構成

```
guarded-webfetch-claude/
├── SKILL.md
├── scripts/
│   ├── sanitize.ts         # 静的サニタイザ（依存ゼロ）
│   └── pipe-sanitize.ts    # 隔離プロセス出力→sanitize→stdout パイプスクリプト
└── references/
    ├── design-plan.md      # このドキュメント
    ├── fetch-output-schema.json      # 隔離プロセス用 --json-schema
    ├── quarantine-fetch-settings.json # 隔離プロセス用 permission 設定
    └── injection_patterns.md  # 既知パターン集（運用時に更新）
```

隔離プロセスは `claude -p` で起動するため、別ファイルでのエージェント定義は不要。隔離プロセス用プロンプトテンプレートは SKILL.md 内に記述する。

## 6. 実行フロー

**ステップ 0: 前提条件チェック（最初に必ず実行）**

```bash
.claude/skills/guarded-webfetch-claude/scripts/check-node-version.sh
```

このチェックは SKILL.md のステップ 0 として main agent が Bash ツールで実行する。23.6 未満の場合はスクリプトが exit code 3 で終了するので、ユーザーに以下を伝えて中止:

> この skill は Node.js 23.6 以降を必要とします（TypeScript を追加ツールなしで直接実行するため）。現在の Node バージョンは `<取得したバージョン>` です。`nvm install --lts` 等で新しいバージョンをインストールしてから再度お試しください。

`<取得したバージョン>` には `check-node-version.sh` が stderr に出力する `(現在: vXX.YY.Z)` 部分の値を埋める。`scripts/quarantine-fetch.sh` も冒頭で同じバージョンチェックを行う。これは多層防御として残しており、main agent が事前チェックを省いた場合でも fetch 実行前に必ず止まる。

**ステップ 1: 対象 URL の特定**

ユーザー要求を受けたら対象 URL を特定する。

- 単一 URL の場合はそのまま使用する
- 複数 URL が指定された場合は各 URL を個別に処理する

**ステップ 2: fetch + sanitize（パイプ接続）**

対象 URL ごとに隔離プロセスと pipe-sanitize.ts をパイプで接続して実行する。複数 URL の場合は各 URL ごとに**並列起動**する（Bash tool の複数同時呼び出し）。**最大 5 件**まで（経験則として、Bash tool の同時並列上限を意識しつつ、隔離プロセスごとに API 呼び出しが発生する点を踏まえてレートリミットに抵触しにくい値として設定。プランや状況によって適正値は変動しうるが、初期値として 5 件で運用する）。超過分はユーザーに確認の上追加処理する。

```bash
skill_dir=".claude/skills/guarded-webfetch-claude"
fetch_schema="$(cat "$skill_dir/references/fetch-output-schema.json")"
fetch_settings="$skill_dir/references/quarantine-fetch-settings.json"

# 隔離プロセスの出力を pipe-sanitize.ts にパイプ接続
# main agent のコンテキストにはサニタイズ済みテキストのみが入る
CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 \
CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 \
ENABLE_CLAUDEAI_MCP_SERVERS=false \
CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1 \
CLAUDE_CODE_SKIP_PROMPT_HISTORY=1 \
claude -p \
  --tools "WebFetch" \
  --allowedTools "WebFetch" \
  --settings "$fetch_settings" \
  --json-schema "$fetch_schema" \
  --output-format json \
  --max-turns 3 \
  "（隔離プロセス用プロンプト — 正式なテンプレートは SKILL.md を参照）" \
  | node "$skill_dir/scripts/pipe-sanitize.ts" '<対象URL>'
```

> **シェルインジェクション防止**: URL を埋め込む際は必ずシングルクォートで囲む。ダブルクォートや `$()` を含む URL がシェル展開されるのを防ぐため。URL にシングルクォートが含まれる場合は `'\''` でエスケープする。このエスケープ処理は main agent のソフト判断に依存し、SKILL.md のテンプレートで手順を明示する。

pipe-sanitize.ts は以下を行う:

1. CLI 引数の URL を**必須として**検証（未指定または `http://` / `https://` 以外のプロトコルは fail-closed で exit code 1）。CLI URL 未指定時に stdin の URL を fallback で使うとオリジン検証が完全にスキップされるため、深層防御として CLI URL を必須化する
2. stdin から `claude -p --output-format json` の出力 JSON を読む
3. `subtype === "success"` と `structured_output.raw_text` の存在を検証
4. CLI 引数の URL と隔離プロセスが返した URL のオリジン（scheme + host + port）を比較。不一致の場合は fail-closed でエラー終了
5. `raw_text` に対して sanitize.ts の `sanitize()` 関数を呼ぶ（`requested_url` と `fetched_url` を個別に渡す）
6. サニタイズ済み結果（`SanitizedDoc` JSON）を stdout に出力
7. 検証失敗時は stderr にエラーを出力し exit code 1 で終了

> **URL のオリジン比較による改竄検知**: pipe-sanitize.ts は CLI 引数の URL（ユーザーが要求した URL）と隔離プロセスが返した URL を比較し、許容範囲外への遷移はエラーとする。これは隔離プロセスが別サイトのコンテンツを fetch し、要求 URL の内容として偽装するのを防ぐ。
>
> **許容する遷移**:
>
> - 完全一致（同一スキーム・同一ホスト・同一ポート・パスは任意）
> - HTTPS 昇格: `http://` → `https://`（同一ホスト・同一ポート）
> - `www.` プレフィクスの追加または除去（同一スキーム・同一ポート）
> - 上記の組み合わせ
>
> **拒否する遷移**:
>
> - HTTPS から HTTP への降格
> - クロスオリジンへの遷移（CDN/別ホストなど。eTLD+1 判定は public suffix list が必要なため対応しない）
> - ポート変更
>
> 出力の `SanitizedDoc` には `requested_url`（CLI 引数）と `fetched_url`（隔離プロセスの返却値）が両方含まれ、main agent がコンテンツの出所を正確に把握できる。

レートリミットリトライは `quarantine-fetch.sh` 内で実装する。`claude -p` の stderr に `rate limit` / `429` / `too many requests` / `overloaded` のいずれかが含まれていた場合、10 秒待機後に 1 回だけ再試行する。レートリミット以外のエラー（ネットワークタイムアウト、DNS 解決失敗、HTTP 4xx/5xx 等）はリトライせずそのまま exit code 1 で終了する。リトライしても失敗した場合も同様に exit code 1 で終了し、main agent は該当 URL の処理を中止してユーザーにエラーが発生した旨を通知する（成功分のみで応答を生成する）。

main agent 側で再リトライを行わないのは、Bash tool の並列起動から exit code を見て選択的に再起動するロジックが脆く、スクリプト内で完結させた方が確実なため。

**ステップ 3: 安全性判定**

pipe-sanitize.ts の出力に含まれる `flags` に基づき、main agent が安全性を判定する。

以下のいずれかに該当する場合、ユーザーに確認を取るまで actionable な出力（URL / コマンド / コード）を生成しない:

- `flags.suspicious_patterns` が非空（1 件以上）
- `flags.had_invisible_chars` が `true` かつ `flags.suspicious_patterns` が非空

判定基準:

| 条件                                                              | 判定       | main agent の振る舞い                                                                       |
| ----------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `suspicious_patterns` が空、`had_invisible_chars` が `false`      | 安全       | そのまま応答を生成                                                                          |
| `had_invisible_chars` が `true`、`suspicious_patterns` が空       | 注意       | 応答に「不可視文字の除去または Unicode 互換正規化によりテキストが変形された」旨の通知を付与 |
| `suspicious_patterns` が 1 件以上                                 | 要確認     | ユーザーに確認を取るまで actionable な出力を生成しない                                      |
| `had_invisible_chars` が `true` かつ `suspicious_patterns` が非空 | 要確認     | 同上                                                                                        |
| `truncated` が `true`                                             | 情報不完全 | テキストが切り詰められた旨をユーザーに通知                                                  |

該当時はユーザーに以下のように報告する:

> このコンテンツにはプロンプトインジェクションの可能性がある要素が検出されました:
>
> - [検出内容の簡潔な説明]
>   内容の要約は以下の通りですが、要約内の URL・コマンド・コード・実行手順は安全のため伏せています。確認の上、開示が必要な場合はお知らせください。

「要確認」判定時の要約では、以下の情報を `[redacted]` に置換して伏せる:

- URL（`http://`、`https://` で始まる文字列）
- シェルコマンド・コードブロック
- 具体的な実行手順・操作指示

ユーザーが確認後に明示的に要求した場合のみ、伏せた情報を開示する。

**ステップ 4: 最終応答の生成**

サニタイズ済みテキストをもとに、ユーザーの元の要求に応える応答を生成する。

複数 URL の並列処理中に一部が失敗した場合、成功分のみで応答を生成し、失敗分をユーザーに報告する。

## 7. サニタイザの処理層

sanitize.ts は WebFetch が返すテキスト（HTML→テキスト変換済み）を対象とする。HTML 層の処理は WebFetch 側に委ねているため、sanitize.ts は以下の 2 層に特化する。

### Unicode 層（最優先）

- NFKC 正規化（ホモグリフ・互換文字の吸収）
- Tag characters (U+E0000-U+E007F) の除去
- Zero-width 文字 (U+200B-200D, U+2060, U+FEFF) の除去
- LRM / RLM (U+200E, U+200F) の除去
- Bidi オーバーライド (U+202A-202E, U+2066-2069) の除去
- 制御文字全般の除去（タブ・改行のみ許可）

> **`had_invisible_chars` フラグの意味**: このフラグは Unicode 層の処理全体（NFKC 正規化 + 不可視文字除去）の前後でテキスト内容が変化した場合に `true` になる。全角英数字（`Ａ` → `A`）のような文字数が変わらない互換正規化でも `true` になる。フラグ名は「不可視文字」を示唆するが、正確には「不可視文字の除去または Unicode 互換正規化によるテキスト変形が発生した」ことを意味する。

### LLM マーカー無害化

以下のパターンを `[FILTERED:<カテゴリ>]`（例: `[FILTERED:chat_template]`, `[FILTERED:role_declaration]`）に置換し、sanitize.ts の出力 JSON の `suspicious_patterns` 配列に記録する。置換マーカーにカテゴリを含めることで、攻撃テキスト内に意図的に埋め込まれた `[FILTERED]` 文字列との区別を可能にする。エスケープ処理は以下の順序で行う（順序重要）:

1. 入力テキスト中の既存 `[ESCAPED:` を `[ESCAPED:ESCAPED:` に再帰エスケープ
2. 入力テキスト中の既存 `[FILTERED` を `[ESCAPED:FILTERED` にエスケープ
3. LLM マーカーを `[FILTERED:<カテゴリ>]` に置換

これにより、攻撃者が `[ESCAPED:FILTERED]` を入力に含めた場合も `[ESCAPED:ESCAPED:FILTERED]` となり、sanitize.ts が付与したマーカーと区別可能になる:

- チャットテンプレート: `<|im_start|>`, `<|im_end|>`, `<|endoftext|>`, `[INST]`, `[/INST]`
- 擬装タグ: `<s>`, `<assistant>`, `<user>`, `<untrusted_content>` 等の開閉タグ
- ロール宣言: 行頭の `human:`, `assistant:`, `system:`
- 指示上書き: `ignore (previous|prior|above) instructions`, `disregard (previous|...)`, `new instructions:`, `you are now ...`

### 量的制限

- テキスト: 50,000 UTF-16 code unit 上限（超過したら `truncated: true`）
- **truncation はパイプラインの最初に実行**: 入力テキストを先に 50,000 code unit に切り詰めた後、NFKC 正規化とマーカー走査を行う。これにより巨大なペイロードが送られた場合でも処理コストの上限が保証される
- **grapheme 境界より code unit 境界を優先**: 末尾でサロゲートペアや絵文字 ZWJ シーケンスが壊れる可能性があるが、攻撃者が単一 grapheme cluster に combining mark を大量に積むことで NFKC 正規化や regex 走査の処理コストを跳ね上げる経路を塞ぐため、grapheme 境界での切断ではなく code unit 単位で確実に上限をかけることを優先する。末尾数文字の文字化けは脅威モデル外として許容する

## 8. 隔離プロセス仕様

### ランタイム制約

| フラグ / 環境変数 | 値                               | 制約の強度                                                         |
| ----------------- | -------------------------------- | ------------------------------------------------------------------ |
| `--tools`         | `"WebFetch"`                     | ハード（WebFetch のみ。Bash / Read / Write / Edit 等は存在しない） |
| `--allowedTools`  | `"WebFetch"`                     | WebFetch を自動許可                                                |
| `--settings`      | `quarantine-fetch-settings.json` | ハード（後述）                                                     |
| 環境変数          | セクション 4 参照                | ハード                                                             |
| `--output-format` | `json`                           | ハード（結果を JSON ラッパーで返す）                               |
| `--json-schema`   | `fetch-output-schema.json`       | ハード（`structured_output` をスキーマ検証で強制）                 |
| `--max-turns`     | `3`                              | ハード（WebFetch 1 回 + リトライ 1 回 + 出力。実測で確認済み）     |

### settings（`quarantine-fetch-settings.json`）

```json
{
  "permissions": {
    "allow": ["WebFetch"],
    "deny": ["Read", "Write", "Edit", "MultiEdit", "Bash", "Agent", "Glob", "Grep", "NotebookEdit"]
  }
}
```

- `allow` に WebFetch のみ: `-p` モードではユーザーに確認を求められないため、`allow` リスト外のツール呼び出しは自動的に拒否される
- `deny` に Bash を含む: 隔離プロセスでは Bash を使用しないため、`allow` との競合なし
- `deny` に Read / Write / Edit / MultiEdit / Agent / Glob / Grep / NotebookEdit を含む: `--tools` との多層防御。`--tools "WebFetch"` でこれらのツールは存在しないが、defense in depth として deny にも含める

### 出力スキーマ（`fetch-output-schema.json`）

```json
{
  "type": "object",
  "required": ["url", "raw_text", "fetch_success"],
  "properties": {
    "url": { "type": "string" },
    "raw_text": { "type": "string" },
    "fetch_success": { "type": "boolean" },
    "error_message": { "type": "string", "maxLength": 500 }
  },
  "additionalProperties": false
}
```

- `error_message` の `maxLength: 500`: 隔離プロセスのモデルがインジェクションにより error_message フィールドに攻撃的な内容を流し込むリスクを制限するための上限。エラーメッセージとして十分な長さを確保しつつ、攻撃ペイロードのサイズを抑える
- `raw_text` に `maxLength` は設定しない: 文字数制限は sanitize.ts の `MAX_CHARS`（50,000 文字）に一本化する。schema 側で `maxLength` を設定すると、隔離プロセスのソフト制約（プロンプトでの切り詰め指示）が守られなかった場合に schema validation が失敗し、sanitize.ts の `truncated: true` フラグが機能しなくなるため。隔離プロセスのプロンプトには「raw_text は 50,000 文字以内に切り詰めて返すこと」という指示を含めるが（ソフト制約。SKILL.md のプロンプトテンプレートと統一すること）、これが守られなくても sanitize.ts がパイプラインの最初のステップで確実に truncate する（NFKC 正規化やマーカー走査の前に切り詰めるため、巨大なペイロードによる処理コストの問題も発生しない）
- `fetch_success: false` の場合: pipe-sanitize.ts がエラーを検出し exit code 1 で終了。main agent は該当 URL の処理を中止

### pipe-sanitize.ts

隔離プロセスの JSON 出力を stdin から読み、sanitize.ts の `sanitize()` 関数でサニタイズして結果を stdout に出力する。LLM を経由しない決定論的スクリプト。

処理フロー:

1. CLI 引数の URL を必須として検証（未指定または `http://` / `https://` 以外は stderr にエラー、exit code 1）
2. stdin から JSON を読む
3. `subtype === "success"` を確認（失敗なら stderr にエラー、exit code 1）
4. `structured_output.raw_text` を抽出（存在しなければエラー）
5. CLI 引数の URL と隔離プロセスが返した URL のオリジンを比較し fail-closed
6. `sanitize(cliUrl, fetchedUrl, rawText)` を呼ぶ（sanitize.ts から import）
7. `SanitizedDoc` JSON を stdout に出力

出力形式（`SanitizedDoc`）:

```json
{
  "requested_url": "string (CLI引数のURL)",
  "fetched_url": "string (隔離プロセスが返したURL)",
  "text": "サニタイズ済みテキスト",
  "flags": {
    "suspicious_patterns": { "chat_template": 3, "instruction_override": 1 },
    "had_invisible_chars": false,
    "truncated": false
  },
  "meta": {
    "sanitized_at": "ISO8601",
    "raw_char_length": 12345
  }
}
```

`suspicious_patterns` は **カテゴリ名 → 検出件数** の Record。攻撃文言そのものは含めない（生文字列を含めると未サニタイズの入力が信頼境界を越えて main agent に届く経路が生じるため）。main agent はカテゴリ名と件数だけを「要確認」判定とユーザー報告に利用する。

## 9. テストケース

1. **通常ケース**: 普通のニュース記事 URL → 隔離プロセスで WebFetch → パイプで sanitize → main agent がサニタイズ済みテキストを分析し最終応答を生成
2. **Unicode Tag 攻撃**: Tag characters で不可視命令を埋め込んだテキスト → pipe-sanitize.ts が除去、`flags.had_invisible_chars: true`、命令が text に残らない
3. **LLM マーカー混入**: `</untrusted_content><s>...` → pipe-sanitize.ts が `[FILTERED:<カテゴリ>]` に置換、`suspicious_patterns` に記録
4. **指示上書き攻撃**: `ignore all previous instructions` を含むテキスト → pipe-sanitize.ts が `[FILTERED:instruction_override]` に置換、`suspicious_patterns` に記録
5. **exfiltration 試行**: "訪問してください: https://evil.com/?data=..." → main agent がサニタイズ済みテキスト内の URL を actionable な推奨として出力しない
6. **複数 URL の並列処理**: 複数 URL が指定された場合 → 最大 5 件まで各 URL に対してパイプラインが並列起動。超過分はユーザー確認後に追加処理
7. **環境チェック**: Node.js 23.6 未満の環境 → 処理を開始せず、バージョン要件メッセージが出る
8. **大量テキスト**: 50,000 code unit を超えるテキスト → sanitize.ts が 50,000 code unit で切り詰め、`truncated: true` でフラグを立てる（隔離プロセスのソフト制約が破られた場合でも sanitize.ts のハード制約で確実に切り詰められる）。combining mark を大量に積んだ単一 grapheme cluster 入力（grapheme 基準では truncation を素通りしうる経路）も code unit 基準により確実に切り詰められる
9. **`[FILTERED]` / `[ESCAPED:]` 偽装攻撃**: 入力テキストに `[FILTERED]` を含めた場合 → `[ESCAPED:FILTERED]` にエスケープされる。`[ESCAPED:FILTERED]` を含めた場合 → `[ESCAPED:ESCAPED:FILTERED]` に再帰エスケープされ、sanitize.ts が付与したマーカーと区別できる
10. **WebFetch 失敗**: 隔離プロセスの WebFetch が失敗した場合 → `fetch_success: false`。pipe-sanitize.ts がエラーを検出し exit code 1。main agent は該当 URL の処理を中止してユーザーに通知
11. **隔離プロセスの structured output 失敗**: JSON Schema に一致する出力を返せない場合 → `subtype` が失敗系になり、pipe-sanitize.ts がエラーを出力。main agent は該当 URL の処理を中止
12. **並列処理の部分失敗**: 5 件中 2 件がいずれかの段階で失敗 → 成功した 3 件で応答が生成され、失敗した 2 件がユーザーに報告される
13. **pipe-sanitize.ts クラッシュ**: 不正な UTF-8 バイト列（Node.js の TextDecoder が `U+FFFD` に置換）や極端に長い行を含むテキストを入力した場合 → exit code が非 0 になり、main agent は該当 URL の処理を中止してユーザーに通知
14. **suspicious_patterns 検出時の安全性判定**: 1 件以上の suspicious_patterns → main agent がユーザーに確認を取るまで actionable な出力を生成しない

テストは sanitize.ts / pipe-sanitize.ts の単体テストとして自動化する（Vitest の in-source testing 機能を使用、`import.meta.vitest`）。Vitest は開発時のみの依存であり、ランタイムの「依存ゼロ」方針とは両立する。E2E テスト（隔離プロセスを含む統合テスト）は手動で実施する。

## 10. 設計上の割り切り

- **WebFetch の HTML→テキスト変換ロジックは非公開**: HTML 層の処理（script/style 除去、hidden 要素除去等）を WebFetch に委ねているが、変換の詳細は Anthropic 側で管理されており完全な保証はない。`display:none` の隠しテキストが変換を通過する可能性がある（既知の限界）
- **隔離プロセスのモデルが生テキストに触れる**: 隔離プロセス内で WebFetch 後のテキストはモデルコンテキストに入る。ただし隔離プロセスは「取得して返すだけ」の単純タスクであり分析や判断を行わないため、インジェクションの影響は限定的。さらに `--tools "WebFetch"` + `deny: ["Bash"]` でファイルシステムアクセスを持たず、出力は `--json-schema` で構造が強制される
- **main agent がサニタイズ済みテキスト全文を見る**: main agent のコンテキストにサニタイズ済みテキスト全文が入る。sanitize.ts による LLM マーカー・不可視文字の無害化は行われているが、自然言語で巧妙に記述されたソーシャルエンジニアリング型の指示注入はサニタイザでは検出できない。main agent の判断力に依存する
- **`--bare` は使用しない**: セクション 4 参照
- **依存ゼロ**: Node 標準のみで完結させることで Skill の配布性を最大化
- **フォールバックなし**: Node 23.6 未満は fail-fast。複数の実行経路を持つと保守性が落ちる
- **ローカルファイルの出所追跡は不可**: 外部由来のファイルがローカル保存される経路を自動追跡する仕組みはなく、main agent のソフト判断に依存する（セクション 3 参照）
- **URL のシェルインジェクション防止は多層**: main agent → `quarantine-fetch.sh` の呼び出しで URL を `'...'` で囲むのは main agent のソフト判断に依存する。一方、`quarantine-fetch.sh` の入口でスキーム検証（`http://` / `https://` のみ）・禁止文字検証（`` ` ``、`$(`、制御文字）を行い、不正な URL は API コスト発生前に exit code 2 で弾く（ハード制約）。シングルクォートは URL の path / query で合法（RFC 3986 の `sub-delims`）かつヒアドキュメント (sigil 無し) でもシェル展開の対象でないため許容する。pipe-sanitize.ts 側の `validateCliUrl` は深層防御として残す。プロンプト整形は LLM がどこまでを URL とみなすかの曖昧さを避けるため、URL を引用符で囲わず独立した行に配置する形式（`URL:\n${URL}`）に統一している。URL の path / query 内の文字でプロンプトの構造的解釈を変える可能性は完全には排除できない（ソフト制約）
- **隔離プロセスの stderr が main agent に流れる経路は残る**: `quarantine-fetch.sh` は失敗時に隔離プロセスの stderr を `cat ... >&2` でそのまま親に流す。通常は `claude -p` 自体が出すシステム的なエラー文（ネットワーク失敗・レートリミット通知等）であり、隔離プロセスのモデル出力は `--output-format json` の stdout 側に整形されるため、サニタイザを経由せずに main agent に届くのは主に CLI レイヤのメッセージである。ただしランタイムの仕様変更や巧妙な入力で stderr 側に攻撃ペイロードが現れる可能性は完全には排除できない。リスクは低いが、stderr 経路はサニタイザを通っていない点を割り切りとして明示する
- **完全防御ではない**: `suspicious_patterns` 多数ヒット等があれば main agent 側でユーザー確認を強制する運用で補完。SKILL.md にもその旨を明記
- **パターンリストの陳腐化**: LLM マーカーのパターンリスト（セクション 7）は新しい攻撃手法の出現により陳腐化する。`references/injection_patterns.md` を更新する運用で対応し、新しいモデルや攻撃手法が公開された際にパターンを見直す
- **LLM マーカーの過検出**: `<s>` / `</s>` は Llama BOS/EOS マーカーと HTML strikethrough タグが衝突する。`you are now ` / `new instructions:` は通常の英文記事中にも自然に出現する。WebFetch の HTML→text 変換が想定通り効かないページや、これらのフレーズを含む正常コンテンツは false positive で「要確認」判定になりうる。設計上「過検出寄りで fail-closed、ユーザー確認で運用補完」という方針を採用しているが、過検出が頻発する場合は `references/injection_patterns.md` でパターンを見直す

## 11. 将来的な拡張候補

- **2段隔離プロセス構成**: 隔離プロセスを fetch 専用と分析専用の 2 つに分離し、分析モデルにサニタイズ済みテキストのみを見せる。セキュリティを強化する代わりにレイテンシが増大する
- **他社モデルによる二重検証**: 隔離プロセスの出力をさらに別ベンダモデル（Gemini / GPT 等）で検証し、モデル固有脆弱性の相関を下げる
- **CaMeL 的アプローチ**: データフローに capability tag を付けて情報の出所を追跡（Google DeepMind の提案）
- **SDK / claude.ai 移植**: `claude -p` は Claude Code CLI 固有の機能。SDK 版では Anthropic API の直接呼び出しでツール制限付きセッションを再現する必要がある
- **キャッシュ層**: `scripts/cache/` に JSON を保存してトークン削減。実装時にはキャッシュポイズニング（悪意あるレスポンスがキャッシュされ再利用される）のリスクに対応するため、キャッシュ TTL の設定とキャッシュ無効化の仕組みが必要
- **ヒューリスティックパターンの拡充**: `references/injection_patterns.md` を育てる
- **過検出パターンの精緻化**: `instruction_override` カテゴリの `you are now ` / `new instructions:` などは行内の任意位置にマッチするため、技術記事の通常の英文でも false positive を起こしうる。現状は「過検出寄りで fail-closed、ユーザー確認で運用補完」の方針を採用しているが、運用上負担が大きい場合は (1) 行頭境界条件の付与、(2) 周辺 N 文字内に他のマーカーが併存することを必須とする、(3) WebFetch 後のテキストで HTML タグが残存している割合を見て信頼度を加減する、などの精緻化が考えられる。`<s>` / `</s>` の HTML strikethrough との衝突も同様の方針で対応可能

## 12. 参考資料

- Simon Willison "Dual LLM pattern"（オリジナルの隔離モデル提案）-- https://simonwillison.net/2023/Apr/25/dual-llm-pattern/
- Google DeepMind CaMeL（capability-based データフロー追跡）-- https://arxiv.org/abs/2503.18813
- Anthropic WebFetch ツール公式ドキュメント（URL 検証・データ流出リスク・動的フィルタリング等）-- https://platform.claude.com/docs/ja/agents-and-tools/tool-use/web-fetch-tool
- Claude Code CLI リファレンス（`claude -p` パイプモード、`--tools`、`--allowedTools` フラグ）-- https://docs.anthropic.com/en/docs/claude-code/cli-usage
- Claude Code 環境変数リファレンス（`CLAUDE_CODE_DISABLE_CLAUDE_MDS`、`CLAUDE_CODE_SIMPLE` 等）-- https://code.claude.com/docs/ja/env-vars
- AWS "Defending LLM applications against Unicode character smuggling" -- https://aws.amazon.com/blogs/security/defending-llm-applications-against-unicode-character-smuggling/
- Cisco "Understanding and Mitigating Unicode Tag Prompt Injection"
- Promptfoo "The Invisible Threat: Zero-Width Unicode Characters"
