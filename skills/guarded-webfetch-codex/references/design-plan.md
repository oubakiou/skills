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

指定された URL のコンテンツを Claude 親エージェントが扱う際、Node.js 標準 `fetch()` による direct HTTP fetcher を隔離取得層として使用し、プロンプトインジェクション攻撃の影響を抑制するためのガード層を提供する。

設計の核は `guarded-webfetch-claude` と同じく **「untrusted content と特権的判断・ツール実行の論理的分離」** にある。HTTP fetcher が URL の取得と素朴な本文抽出だけを担当し、その出力を静的サニタイザに通した結果だけを親 Claude に渡すことで、生の Web コンテンツが main agent のコンテキストに直接入ることを避ける。

本設計では次の 3 層を採用する。

1. **direct HTTP fetcher による取得 (ハード)** — `node http-fetch-codex.ts <URL>` を使い、HTTP GET、リダイレクト制限、サイズ制限、content-type 検証、本文抽出を決定的なコードで実行する。Codex の `web_search` やモデル判断には依存しない
2. **静的サニタイザ (ハード)** — fetcher の JSON 出力を `pipe-sanitize-codex.ts` にパイプし、出力スキーマ検証、オリジン検証、Unicode 不可視文字除去、LLM マーカー無害化をランタイム強制する
3. **安全性フラグによる行動制御 (ソフト)** — `sanitize.ts` が出力する `suspicious_patterns`、`had_invisible_chars`、`truncated` 等をもとに、親 Claude が応答可否を判断する

### アーキテクチャ概要

```text
main Claude agent
  └─ Bash: quarantine-fetch-codex.sh "<url>"
       │
       │  パイプ内部:
       │  ┌────────────────────────────────────┐
       │  │ direct HTTP fetcher (Node fetch)   │
       │  │  HTTP GET → 本文抽出 → JSON        │
       │  └──────────┬─────────────────────────┘
       │             │ stdout (fetch-output JSON)
       │             ▼
       │  ┌────────────────────────────────────┐
       │  │ pipe-sanitize-codex.ts            │
       │  │  schema検証 → sanitize()          │
       │  └──────────┬─────────────────────────┘
       │             │ stdout (サニタイズ済みJSON)
       ▼
  main Claude agent のコンテキスト: サニタイズ済みテキスト + flags のみ
```

この skill はインジェクション対策の **緩和策** であり、完全防御ではない。direct HTTP fetcher 化により LLM 子プロセスのツール横滑りやモデル判断による取得失敗は避けるが、SSRF、リダイレクト悪用、巨大レスポンス、HTML 内の自然言語インジェクションは引き続き明示的に制御する必要がある。

## 2. 脅威モデル

想定する攻撃:

- **不可視 Unicode 攻撃**: Tag characters (U+E0000-U+E007F)、zero-width 文字、bidi オーバーライドを使った不可視命令の埋め込み
- **LLM チャットテンプレート擬装**: `<|im_start|>`, `</untrusted_content>`, `[INST]`, `Human:` などのマーカーで役割境界の脱出を試みる
- **間接的指示注入**: "ignore previous instructions", "you are now", "new instructions:" などのパターン
- **JSON 出力偽装**: fetcher 出力に schema に見合うが悪意あるペイロードが混入する試み
- **URL 改竄**: 要求した URL と異なるオリジンのコンテンツを返し、親に別サイトの内容を誤認させる試み
- **SSRF / 内部ネットワーク到達**: URL やリダイレクト先が localhost、private IP、link-local、metadata endpoint 等を指すリスク
- **リダイレクト悪用**: 許可された外部 URL から別オリジンや危険なスキームへ遷移するリスク
- **巨大レスポンス / slow response**: サイズ制限や timeout を回避してリソースを消費させるリスク
- **`[FILTERED]` / `[ESCAPED:]` マーカーの悪用**: sanitize.ts の付与マーカーとの区別を曖昧にする試み

想定しない攻撃:

- モデル重み自体への攻撃
- 自然言語で巧妙に埋め込まれた高度なソーシャルエンジニアリング
- 親 Claude がスキルをバイパスして直接 Web コンテンツを読む運用ミス

## 3. トリガー条件

以下のいずれかに該当するとき発火させる。

- ユーザーが URL を提示し、その内容取得・要約・分析を要求した
- 親を Claude に保ったまま、Codex skill として direct HTTP fetcher を使いたい
- Web コンテンツを Claude 親のコンテキストに直接入れたくない

以下の場合は本スキルの対象外とする。

- Web 検索クエリの実行が主目的である場合
- Claude 子の `WebFetch` で十分な場合

ローカルファイルについては、保存場所ではなく出所で判断する。外部由来の HTML / Markdown / テキストをローカル保存してから読む場合も、本質的には同じ脅威モデルを持つ。

## 4. 動作環境と制約

前提条件:

- Node.js 23.6 以降
- direct HTTP fetcher から対象 URL への `GET` / `HEAD` 相当のネットワーク到達が許可されていること

Codex 版の重要な制約:

- `codex --search exec` は URL fetch 専用ではなく、検索インデックス・web tool・モデル判断・ローカルコマンド実行可否に依存するため、任意 URL 本文取得の主経路には使わない
- direct HTTP fetcher は `GET` のみを実行し、ユーザー指定 URL と各リダイレクト先を検証する
- sandbox は Node.js fetcher の実行に必要な最小権限を使う。Codex CLI の `--sandbox read-only` 初期化失敗には依存しない
- JavaScript 実行が必要な SPA の本文抽出は保証しない。SSR HTML、plain text、JSON、XML を主対象にする

## 5. ディレクトリ構成

```text
guarded-webfetch-codex/
├── SKILL.md
├── references/
│   ├── design-plan.md
│   └── fetch-output-schema.json
└── scripts/
    ├── check-node-version.sh
    ├── codex-jsonl.ts
    ├── http-fetch-codex.ts
    ├── quarantine-fetch-codex.sh
    ├── pipe-sanitize-codex.ts
    └── sanitize.ts
```

- `sanitize.ts` は `shared/sanitize/sanitize.ts` を正本とし、`scripts/sync-shared.ts` で配布された自動生成コピー（全 4 skill で同一実装）
- `http-fetch-codex.ts` は direct HTTP fetcher。Node.js 標準 `fetch()` で URL を取得し、本文テキストを含む `fetch-output-schema.json` 互換 JSON を stdout に出力する
- `codex-jsonl.ts` は過去の `codex --search exec` 経路との互換・移行期間用ユーティリティ。新しい主経路では使用しない
- `check-node-version.sh` は main agent の事前チェックと quarantine スクリプトからのサブプロセス呼び出しの両方で使う
- 一時ファイルや隔離用 cwd は `.temp/guarded-webfetch-codex/` 配下に実行ごとの `run-XXXXXXXX/` を `mktemp -d` で切り、`trap EXIT` で削除する（並列起動や前回実行の残留ファイル混入を避けるため）

## 6. 実行フロー

### ステップ 1: URL の特定

- 明示的な URL をそのまま使う
- 複数 URL は URL ごとに個別処理する
- 並列処理は最大 5 件までとする

### ステップ 2: fetch + sanitize

各 URL に対して次を実行する。

```bash
bash .claude/skills/guarded-webfetch-codex/scripts/quarantine-fetch-codex.sh '<対象URL>'
```

`quarantine-fetch-codex.sh` は以下を行う。

1. Node.js の存在確認
2. URL の入口検証 (`http://` / `https://` プレフィクス、バッククォート / `$()`、制御文字) を実施
3. `.temp/guarded-webfetch-codex/run-XXXXXXXX/` を `mktemp -d` で隔離用 cwd として作成し、`trap EXIT` で削除する
4. `node "$SCRIPT_DIR/http-fetch-codex.ts" "$URL"` を実行し、取得結果 JSON を stdout に出す
5. fetcher の JSON 出力を `pipe-sanitize-codex.ts` にパイプする
6. 取得失敗時は `fetch_success=false` と `error_message` を返し、後段で fail-closed する

`http-fetch-codex.ts` は次を実施する。

- 対象 URL と各リダイレクト先の検証 (`http:` / `https:` のみ)
- localhost、private IP、link-local、metadata endpoint 等の拒否
- `GET` のみ実行
- timeout と最大レスポンスサイズの強制
- リダイレクト回数上限の強制
- `content-type` の許可リスト検証
- HTML / plain text / JSON / XML からの本文テキスト抽出
- `fetch-output-schema.json` 互換 JSON の出力

### ステップ 3: fetch 出力検証とサニタイズ

`pipe-sanitize-codex.ts` は以下を行う。

1. CLI 引数の URL を検証（`http://` または `https://` のみ許可）
2. stdin から fetcher の JSON を読み、空なら fail-closed
3. JSON として parse し、`url`, `raw_text`, `fetch_success`, `error_message` を検証
4. `fetch_success === false` なら `error_message` をサニタイズしたうえで fail-closed
5. CLI 引数の URL と取得 URL の遷移を `isAllowedOriginTransition` で検証 (同一オリジン / HTTPS 昇格 / www. プレフィクス差を許容)。許容範囲外なら fail-closed
6. `sanitize(requestedUrl, fetchedUrl, rawText)` を実行し、`SanitizedDoc` JSON を stdout に出力

### ステップ 4: 安全性判定

親 Claude は `flags` に基づき安全性判定を行う。
`fetched_url` は HTTP fetcher が最終的に取得した URL であり、リダイレクト後の URL が入る。

| 条件                                                                                                                 | 判定       | 振る舞い                |
| -------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------- |
| `suspicious_patterns` が空、`had_invisible_chars` が `false`、`requested_url` と `fetched_url` が一致                | 安全       | 通常応答                |
| `requested_url` と `fetched_url` が異なるが許容範囲内 (同一オリジン / HTTP→HTTPS 昇格 / www. プレフィクスの有無の差) | 注意       | 両 URL を通知           |
| `had_invisible_chars` が `true` で `suspicious_patterns` が空                                                        | 注意       | 変形通知付きで応答      |
| `suspicious_patterns` が 1 件以上                                                                                    | 要確認     | actionable な出力を保留 |
| `truncated` が `true`                                                                                                | 情報不完全 | 切り詰めを通知          |

許容範囲外のオリジン遷移 (クロスオリジン / HTTPS→HTTP 降格 / ポート変更) は `pipe-sanitize-codex.ts` で fail-closed され、エラー終了する。許容範囲は Claude 版 (`isAllowedOriginTransition`) と揃えており、HTTP fetcher が末尾 `/` 補完 / www. 補完 / HTTPS 昇格などの一般的な正規化を受けることを前提にしている。

## 7. サニタイザの処理層

`sanitize.ts` は `shared/sanitize/sanitize.ts` の正本から自動生成された共通実装（Claude を含む全 4 skill で同一）。対象は HTTP fetcher が抽出した本文テキストであり、以下の 2 層に特化する。

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

| 項目          | 値                                   | 制約の強度 |
| ------------- | ------------------------------------ | ---------- |
| 取得コマンド  | `node http-fetch-codex.ts <URL>`     | ハード     |
| HTTP method   | `GET` のみ                           | ハード     |
| URL scheme    | `http:` / `https:` のみ              | ハード     |
| redirect      | 回数上限 + 各遷移先の再検証          | ハード     |
| 内部宛先拒否  | localhost / private IP 等を拒否      | ハード     |
| timeout       | 固定上限                             | ハード     |
| response size | 固定上限                             | ハード     |
| content-type  | text / HTML / JSON / XML 系に制限    | ハード     |
| 出力形式      | `fetch-output-schema.json` 互換 JSON | ハード     |
| cwd           | `$QUARANTINE_CWD`                    | ハード     |

- HTTP fetcher は Codex CLI や LLM を起動しない。ホスト側の Codex 設定、execpolicy `.rules`、`--search` の検索・閲覧挙動に影響されない
- DNS 解決後の IP が内部アドレスの場合は拒否する。リダイレクトごとに同じ検証を繰り返す

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

- `error_message` を省略可能にせず常に required にすることで、成功・失敗の両方で pipe 側の検証を単純に保つ
- `raw_text` の `maxLength` は schema に持たせず、sanitize.ts の truncation に一本化する

### `quarantine-fetch-codex.sh`

このスクリプトは Node.js fetcher を隔離用 cwd で起動する。

- **狙い**: LLM / web_search / shell fallback に依存せず、URL 取得を決定的なコードで実行する
- **動作**: fetcher が `fetch_success=false` を返した場合は pipe 側で fail-closed する

### `pipe-sanitize-codex.ts`

direct HTTP fetcher の出力 JSON を sanitize 前に検証する。

- stdin 全体を JSON として parse する
- `url`, `raw_text`, `fetch_success`, `error_message` の型を検証する
- `fetch_success=false` の場合は `error_message` をサニタイズして fail-closed する
- 取得 URL のオリジン遷移を検証する

## 9. テストケース

最低限確認すべきケース:

1. **正常系**: fixture HTML / text を取得し、サニタイズ済み JSON が返る
2. **Zenn 相当 HTML**: Zenn 記事の構造を模した fixture から本文テキストを抽出できる
3. **マーカー検出**: `raw_text` に `<|im_start|>` を含む JSON を `pipe-sanitize-codex.ts` に与え、`[FILTERED:chat_template]` に置換される
4. **fetch_success=false**: fetcher が失敗応答を返した場合、サニタイズ済み `error_message` を含めて fail-closed する
5. **オリジン不一致**: 要求 URL と取得 URL のオリジンが異なる場合に停止する
6. **危険 URL 拒否**: localhost / private IP / metadata IP / 非 HTTP scheme を拒否する
7. **リダイレクト検証**: 許容リダイレクトは通し、クロスオリジンや HTTPS→HTTP 降格は停止する
8. **巨大レスポンス**: fetcher と sanitizer の両方でサイズ上限が効く
9. **timeout**: 応答が遅い場合に失敗応答を返す

テストは `http-fetch-codex.ts` と `pipe-sanitize-codex.ts` の in-source testing を主とし、外部サイトに依存する E2E は手動確認に留める。Zenn 実 URL を固定した自動テストは、外部サイト・DNS・ネットワーク制約に依存するため追加しない。

## 10. 設計上の割り切り

- **JavaScript 実行はしない**: SPA で本文がクライアント実行後にしか現れないページは取得できない場合がある
- **本文抽出は素朴な実装から始める**: 初期実装では追加依存を避け、HTML の一般的な本文候補 (`article`, `main`, JSON-LD 等) と text / JSON / XML を対象にする
- **HTTP fetcher に必要なネットワーク権限は環境依存**: agent / sandbox / CI のネットワーク policy で外部 GET が禁止されている場合は失敗する
- **SSRF 対策は必須**: URL と全リダイレクト先の検証、DNS 解決後 IP の拒否リスト、サイズ・timeout 上限を fetcher 側で強制する
- **main Claude はサニタイズ済み全文を見る**: 自然言語ベースの説得・誘導までは静的サニタイザでは防げない
- **完全防御ではない**: 要確認時に親 Claude が出力を抑制する運用が前提

## 11. 将来的な拡張候補

- **HTML 抽出ライブラリの導入**: 標準実装で本文抽出品質が不足する場合、`jsdom` / `linkedom` / Readability 系を比較検討する
- **サイト固有 extractor**: Zenn など構造が安定しているサイトについて、汎用 extractor の前後に小さなサイト固有処理を追加する
- **HTTP cache / retry policy**: 一時的な DNS / timeout 失敗に対する限定的 retry を導入する
- **guarded-websearch-codex**: 検索結果一覧向けに同じ構造を展開する
- **二段隔離**: HTTP fetcher を取得専用、別プロセスを要約専用に分離する

## 12. 参考資料

- [`guarded-webfetch-claude/references/design-plan.md`](../../guarded-webfetch-claude/references/design-plan.md)（本スキルの基盤となる claude 版 design-plan、同一リポジトリ内）
- Codex CLI `codex exec --help`（CLI ヘルプ出力）
- Codex CLI `codex --help`（CLI ヘルプ出力）
- Node.js `fetch` / WHATWG Fetch API
- Codex 公式ドキュメント "Sandbox & approvals" (https://github.com/openai/codex/blob/main/docs/sandbox.md)
- Codex 公式ドキュメント "Advanced configuration"（Sandbox & Approval Settings、`sandbox_mode` 等の解説を含む）(https://developers.openai.com/codex/config-advanced)
- Codex 公式ドキュメント "Configuration reference"（`config.toml` の Security & Sandbox セクション）(https://developers.openai.com/codex/config-reference)
- AWS Security Blog "Defending LLM applications against Unicode character smuggling" (https://aws.amazon.com/blogs/security/defending-llm-applications-against-unicode-character-smuggling/)
- Promptfoo Blog "The Invisible Threat: Zero-Width Unicode Characters" (https://www.promptfoo.dev/blog/invisible-unicode-threats/)
