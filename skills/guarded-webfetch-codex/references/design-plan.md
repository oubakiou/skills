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

指定された URL のコンテンツを Claude 親エージェントが扱う際、Codex 子プロセス内で Node.js 標準 `fetch()` による direct HTTP fetcher を実行し、プロンプトインジェクション攻撃の影響を抑制するためのガード層を提供する。

設計の核は `guarded-webfetch-claude` と同じく **「untrusted content と特権的判断・ツール実行の論理的分離」** にある。Codex 子プロセス内の HTTP fetcher が URL の取得と素朴な本文抽出を担当し、子 Codex (LLM) が抽出テキストの要約を生成する。これらの出力を静的サニタイザに通した結果だけを親 Claude に渡すことで、生の Web コンテンツが main agent のコンテキストに直接入ることを避ける。

本設計では次の 3 層を採用する。

1. **Codex 子プロセス内の direct HTTP fetcher + サニタイズ + LLM 要約 (ハード寄り)** — `codex exec` 子に `node http-fetch-codex.ts <URL> | node pipe-sanitize-codex.ts <URL>` を実行させ、HTTP GET、リダイレクト制限、サイズ制限、content-type 検証、本文抽出、サニタイズを決定的なコードで実行する。サニタイズ済みの `raw_text` を子 Codex (LLM) が日本語で要約し `summary.txt` に書き出す。Codex の `web_search` には依存しない
2. **静的サニタイザ (ハード)** — `pipe-sanitize-codex.ts` が `raw_html`・`raw_text` にスキーマ検証、オリジン検証、Unicode 不可視文字除去、LLM マーカー無害化をランタイム強制する。`merge-summary-codex.ts` が `summary` にも同じサニタイズを適用し、flags をマージする
3. **安全性フラグによる行動制御 (ソフト)** — `sanitize.ts` が出力する `suspicious_patterns`、`had_invisible_chars`、`truncated` 等をもとに、親 Claude が応答可否を判断する

### アーキテクチャ概要

```text
main Claude agent
  ├─ Bash: quarantine-fetch-codex.sh "<url>"
  │    │
  │    │  ┌────────────────────────────────────┐
  │    │  │ Codex child (codex exec)           │
  │    │  │  ├─ Node HTTP fetcher              │
  │    │  │  │   HTTP GET → 本文抽出 → JSON   │
  │    │  │  │   (raw_html + raw_text)         │
  │    │  │  ├─ pipe-sanitize-codex.ts         │
  │    │  │  │   サニタイズ → sanitized.json   │
  │    │  │  └─ サニタイズ済み raw_text を要約 │
  │    │  │      → summary.txt                 │
  │    │  └──────────┬─────────────────────────┘
  │    │             │ sanitized.json + summary.txt
  │    │             ▼
  │    │  ┌────────────────────────────────────┐
  │    │  │ merge-summary-codex.ts            │
  │    │  │  summary だけ sanitize()          │
  │    │  │  既存 flags とマージ              │
  │    │  └──────────┬─────────────────────────┘
  │    │             │ 最終 JSON
  │    │             ▼
  │    │  .temp/.../results/result-XXXXXXXX.json に保存
  │    └─ stdout: ファイルパスのみ
  │
  ├─ jq 'del(.raw_text,.raw_html)' <result_file>  ← summary + flags
  ├─ jq -r '.raw_text' <result_file>               ← 必要時のみ
  └─ jq -r '.raw_html' <result_file>               ← 必要時のみ
```

この skill はインジェクション対策の **緩和策** であり、完全防御ではない。`web_search` 依存を避け、実際の HTTP 取得は決定的な Node fetcher へ寄せるが、子 Codex がローカルコマンドを実行する構造であるため、プロンプトによるコマンド固定はハードな tool allowlist ではない。SSRF、リダイレクト悪用、巨大レスポンス、HTML 内の自然言語インジェクションは fetcher 側で明示的に制御する必要がある。

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
- **要約経路を通じた間接インジェクション**: 子 Codex はサニタイズ済みの `raw_text` を読んで要約するが、`suspicious_patterns` が検出された場合は `raw_text` 抽出時にコードでゲーティングし、子 Codex に内容を読ませない（`raw_text.txt` が空になり要約をスキップ）。パターン未検出時でも自然言語による説得・誘導は静的サニタイザの対象外であり、子 Codex が意図しない内容を `summary.txt` に書き出すリスクは残る。要約自体も `merge-summary-codex.ts` でサニタイズされるが、内容の正確性は子 Codex の判断に依存する
- **要約時のコマンド実行権限**: 子 Codex は既定で `danger-full-access` sandbox で動作し、サニタイズ済みテキストを読んだ後もコマンド実行権限を保持する。`suspicious_patterns` 検出時はゲーティングにより子 Codex が内容を読まないため、この経路のリスクは緩和される。パターン未検出時は自然言語インジェクションが子 Codex の挙動を変え、任意のシェルコマンドを実行するリスクが残る。現在の緩和策は (1) suspicious_patterns 検出時のゲーティング (2) 読むテキストがサニタイズ済みであること (3) 子 Codex の出力が `merge-summary-codex.ts` で再サニタイズされること (4) 隔離用 cwd が `trap EXIT` で削除されること。fetch/sanitize と LLM 要約を別 invocation に分離し、要約側のコマンド実行権限を制限する構成は将来的な改善候補である
- **sanitized.json の改ざんリスク**: 子 Codex が `sanitized.json` を生成した後、同一 invocation 内で自然言語インジェクションに誘導されてファイルを改ざんする可能性がある。`merge-summary-codex.ts` は JSON の型検証は行うが、`raw_html` / `raw_text` の再サニタイズや `flags` の真正性検証は行わない。完全に防ぐには `sanitized.json` を親側で生成するか、要約を別 invocation に分離して書き込み対象を `summary.txt` のみに制限する必要があるが、前者は子 Codex が未サニタイズテキストを読む構成に戻り、後者は API コストが倍増する。現時点ではこのリスクを受容し、将来的な invocation 分離で対応する

想定しない攻撃:

- モデル重み自体への攻撃
- 自然言語で巧妙に埋め込まれた高度なソーシャルエンジニアリング
- 親 Claude がスキルをバイパスして直接 Web コンテンツを読む運用ミス

## 3. トリガー条件

以下のいずれかに該当するとき発火させる。

- ユーザーが URL を提示し、その内容取得・要約・分析を要求した
- 親を Claude に保ったまま、Codex 子プロセス内の direct HTTP fetcher を使いたい
- Web コンテンツを Claude 親のコンテキストに直接入れたくない

以下の場合は本スキルの対象外とする。

- Web 検索クエリの実行が主目的である場合
- Claude 子の `WebFetch` で十分な場合

ローカルファイルについては、保存場所ではなく出所で判断する。外部由来の HTML / Markdown / テキストをローカル保存してから読む場合も、本質的には同じ脅威モデルを持つ。

## 4. 動作環境と制約

前提条件:

- Node.js 23.6 以降
- `codex` CLI がインストール済みであること
- Codex が認証済みであること（ChatGPT アカウント OAuth ログイン (`codex login`) または `OPENAI_API_KEY` 環境変数）
- Codex 子プロセス内の direct HTTP fetcher から対象 URL への `GET` 相当のネットワーク到達が許可されていること

Codex 版の重要な制約:

- `codex --search exec` は URL fetch 専用ではなく、検索インデックス・web tool・モデル判断・ローカルコマンド実行可否に依存するため、任意 URL 本文取得の主経路には使わない
- direct HTTP fetcher は `GET` のみを実行し、ユーザー指定 URL と各リダイレクト先を検証する
- 子 Codex の sandbox は `CODEX_FETCH_SANDBOX` で上書き可能にし、未設定時は HTTP 取得のため `danger-full-access` を使う。SSRF / redirect / content-type / size 制限は fetcher 側で強制する
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
    ├── merge-summary-codex.ts
    ├── quarantine-fetch-codex.sh
    ├── pipe-sanitize-codex.ts
    └── sanitize.ts
```

- `sanitize.ts` は `shared/sanitize/sanitize.ts` を正本とし、`scripts/sync-shared.ts` で配布された自動生成コピー（全 4 skill で同一実装）
- `http-fetch-codex.ts` は direct HTTP fetcher。Codex 子プロセス内で Node.js 標準 `fetch()` により URL を取得し、生レスポンスボディ (`raw_html`) と抽出テキスト (`raw_text`) を含む `fetch-output-schema.json` 互換 JSON を stdout に出力する
- `merge-summary-codex.ts` は要約マージャ。`sanitized.json` に子 Codex の `summary.txt` を追加する際、summary だけに `sanitize()` を呼び、既存 flags とマージして最終 JSON を出力する
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
4. URL を `.temp/.../fetch-url.txt` に書き、子 Codex のプロンプトには URL 本文を直接埋め込まない
5. `codex exec` を起動し、子 Codex 内で fetcher → `pipe-sanitize-codex.ts` をパイプ実行させ、サニタイズ済み `sanitized.json` を生成する
6. 子 Codex 内で `raw_text` 抽出コードが `sanitized.json` の `suspicious_patterns` をチェックし、非空なら `raw_text.txt` を空にして要約をスキップする。パターン未検出なら `raw_text` を抽出し、子 Codex が日本語要約を `summary.txt` に書き出す
7. 親側で `merge-summary-codex.ts` が `sanitized.json` + `summary.txt` を結合する。summary だけに `sanitize()` を呼び、既存 flags とマージする
8. サニタイズ済み JSON を `.temp/guarded-webfetch-codex/results/result-XXXXXXXX.json` に保存する（隔離用 cwd の `trap EXIT` 対象外）
9. stdout にはファイルパスだけを出力する。テキスト本文は親 Claude のコンテキストに直接入らない
10. 取得失敗時は fetcher が `fetch_success=false` と `error_message` を返し、後段で fail-closed する。結果ファイルは作成されず stdout も空のままとなる

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
3. JSON として parse し、`url`, `raw_html`, `raw_text`, `fetch_success`, `error_message` を検証
4. `fetch_success === false` なら `error_message` をサニタイズしたうえで fail-closed
5. CLI 引数の URL と取得 URL の遷移を `isAllowedOriginTransition` で検証 (同一オリジン / HTTPS 昇格 / www. プレフィクス差を許容)。許容範囲外なら fail-closed
6. `raw_html` と `raw_text` をそれぞれ `sanitize()` に通し、サニタイズ済み JSON を stdout に出力。flags は両フィールドのサニタイズ結果からマージする（`suspicious_patterns` は件数合算、`had_invisible_chars`・`truncated` は OR）。meta は `raw_text` 側から取る。summary は含まない（後段の `merge-summary-codex.ts` で追加）

### ステップ 4: サマリー読み取りと安全性判定

親 Claude は `jq 'del(.raw_text,.raw_html)' <result_file>` で summary + flags を読み、安全性判定を行う。
`fetched_url` は HTTP fetcher が最終的に取得した URL であり、リダイレクト後の URL が入る。

| 条件                                                                                                                 | 判定             | 振る舞い                                                   |
| -------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------- |
| `suspicious_patterns` が 1 件以上                                                                                    | 要確認（最優先） | actionable な出力を保留。`raw_text` はユーザー確認後に限定 |
| `summary_missing` が `true` かつ `suspicious_patterns` が空                                                          | 要約欠落         | `raw_text` を必ず読み、要約なしで応答                      |
| `suspicious_patterns` が空、`had_invisible_chars` が `false`、`requested_url` と `fetched_url` が一致                | 安全             | 通常応答                                                   |
| `requested_url` と `fetched_url` が異なるが許容範囲内 (同一オリジン / HTTP→HTTPS 昇格 / www. プレフィクスの有無の差) | 注意             | 両 URL を通知                                              |
| `had_invisible_chars` が `true` で `suspicious_patterns` が空                                                        | 注意             | 変形通知付きで応答                                         |
| `truncated` が `true`                                                                                                | 情報不完全       | 切り詰めを通知                                             |

`suspicious_patterns` チェックは最優先で行う。検出時は要約もスキップされるため `summary_missing` が同時に立つが、`raw_text` の読み取りはユーザー確認後に限定する。`summary_missing` が `true` かつ `suspicious_patterns` が空の場合のみ、`raw_text` を即座に読む。

許容範囲外のオリジン遷移 (クロスオリジン / HTTPS→HTTP 降格 / ポート変更) は `pipe-sanitize-codex.ts` で fail-closed され、エラー終了する。許容範囲は Claude 版 (`isAllowedOriginTransition`) と揃えており、HTTP fetcher が末尾 `/` 補完 / www. 補完 / HTTPS 昇格などの一般的な正規化を受けることを前提にしている。

## 7. サニタイザの処理層

`sanitize.ts` は `shared/sanitize/sanitize.ts` の正本から自動生成された共通実装（Claude を含む全 4 skill で同一）。対象は `raw_html`（生 HTML）、`raw_text`（抽出テキスト）、`summary`（子 Codex の要約）の全フィールドであり、以下の 2 層に特化する。

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

| 項目          | 値                                              | 制約の強度 |
| ------------- | ----------------------------------------------- | ---------- |
| 取得コマンド  | `codex exec` → `node http-fetch-codex.ts <URL>` | 準ハード   |
| HTTP method   | `GET` のみ                                      | ハード     |
| URL scheme    | `http:` / `https:` のみ                         | ハード     |
| redirect      | 回数上限 + 各遷移先の再検証                     | ハード     |
| 内部宛先拒否  | localhost / private IP 等を拒否                 | ハード     |
| timeout       | 固定上限                                        | ハード     |
| response size | 固定上限                                        | ハード     |
| content-type  | text / HTML / JSON / XML 系に制限               | ハード     |
| 出力形式      | `fetch-output-schema.json` 互換 JSON            | ハード     |
| cwd           | `$QUARANTINE_CWD`                               | ハード     |

- HTTP fetcher は Codex 子プロセス内で実行するが、`--search` は付与しない。URL 本文取得は Codex の検索・閲覧 tool ではなく Node fetcher が担当する
- `--ignore-user-config --ignore-rules` により、ホスト側の Codex 設定や execpolicy `.rules` の影響を抑える
- DNS 解決後の IP が内部アドレスの場合は拒否する。リダイレクトごとに同じ検証を繰り返す。ただし Node.js 標準 `fetch()` では検証時の DNS 結果を接続先へ pin できないため、DNS rebinding は残リスクとして扱う

### Codex runtime state の隔離

Codex CLI は `codex exec --sandbox read-only` であっても、起動時に `$CODEX_HOME` 配下へ runtime state を書き込む。観測された書き込み先には `tmp/arg0`, `state_*.sqlite`, `logs_*.sqlite`, `goals_*.sqlite`, `memories_*.sqlite`, `skills/.system`, `.tmp/plugins.sync.lock` が含まれる。

ただし v0.139.0 での追加調査の結果、`$CODEX_HOME` への書き込みは `read-only` sandbox の制限対象外であることが判明した。sandbox はシェルコマンド実行 (`command_execution`) のファイルシステム・ネットワークを制限するが、`$CODEX_HOME` への state 書き込みは sandbox レイヤーの外側で行われるため、`read-only` でも初期化自体は成功する。v0.139.0 では従来この節で記載していた「`failed to initialize in-process app-server client: Read-only file system`」エラーは再現せず、当時の Codex バージョンまたは環境固有の挙動であったと考えられる。

現在 `read-only` sandbox で本スキルが動作しない実際の原因は、sandbox がシェルコマンド実行に対して**ネットワークアクセスを遮断する**ことにある。`node http-fetch-codex.ts` は子 Codex 内のシェルコマンドとして実行されるため、DNS 解決の時点で `getaddrinfo EAI_AGAIN` により失敗する。

一方 `guarded-websearch-codex` が `read-only` で動作する理由は、Codex の組み込み `web_search` ツール（JSONL イベントの `type: "web_search"`）がサーバーサイドで処理され、sandbox のシェルコマンド制限を受けないためである。この組み込みツールは `--search` フラグの有無に関わらず利用可能で、`codex exec --sandbox read-only` でも `web_search` イベントは発火する。

以下は v0.139.0 で確認した `read-only` sandbox の制限範囲:

| 経路                                 | ネットワーク          | ファイル書き込み      |
| ------------------------------------ | --------------------- | --------------------- |
| シェルコマンド (`command_execution`) | 制限 (DNS 不可)       | 制限 (Read-only)      |
| 組み込みツール (`web_search`)        | 許可 (サーバーサイド) | 該当なし              |
| `$CODEX_HOME` への state 書き込み    | 対象外                | 許可 (sandbox 対象外) |

現在の `CODEX_HOME` 隔離は、実ユーザーの `$CODEX_HOME` を汚染しない目的で維持する。

```bash
CODEX_HOME="$QUARANTINE_CWD/codex-home"
TMPDIR="$QUARANTINE_CWD/tmp"
```

`quarantine-fetch-codex.sh` は子 Codex を起動する際、この `CODEX_HOME` と `TMPDIR` を `codex exec` のコマンド環境変数として渡す（`export` ではなく、`codex exec` の前置のみ）。これにより Codex CLI の状態 DB、一時 alias、system skills、lock file などの書き込みを `$QUARANTINE_CWD` 配下に閉じ込め、`trap EXIT` によって実行後に破棄できる。

URL fetch の安全境界は Codex sandbox ではなく、`http-fetch-codex.ts` の SSRF / redirect / content-type / size / timeout 制限と、`pipe-sanitize-codex.ts` の静的サニタイズに置く。

認証については、`OPENAI_API_KEY` を使う場合は disposable `CODEX_HOME` で完結できる。ChatGPT login の `auth.json` に依存する場合は、実ユーザーの `$CODEX_HOME` を直接書き込み先にせず、必要最小限の認証情報だけを隔離ディレクトリへ読み取り元からコピーする方針を検討する。

### 出力スキーマ（`fetch-output-schema.json`）

```json
{
  "type": "object",
  "required": ["url", "raw_html", "raw_text", "fetch_success", "error_message"],
  "properties": {
    "url": { "type": "string" },
    "raw_html": { "type": "string" },
    "raw_text": { "type": "string" },
    "fetch_success": { "type": "boolean" },
    "error_message": { "type": "string" }
  },
  "additionalProperties": false
}
```

- `raw_html` は HTTP レスポンスボディの生テキスト。`raw_text` は HTML / JSON / XML から本文を抽出したテキスト
- `error_message` を省略可能にせず常に required にすることで、成功・失敗の両方で pipe 側の検証を単純に保つ
- `raw_text` の `maxLength` は schema に持たせず、sanitize.ts の truncation に一本化する
- `summary` は fetcher JSON には含まれず、子 Codex が書き出す `summary.txt` を親側の `merge-summary-codex.ts` がサニタイズしてから結合する

### `quarantine-fetch-codex.sh`

このスクリプトは Codex 子プロセスを隔離用 cwd で起動し、その中で Node.js fetcher とサニタイザをパイプ実行させる。

- **狙い**: LLM / web_search / shell fallback に依存せず、URL 取得を決定的なコードで実行する
- **動作**: 子 Codex 内で `http-fetch-codex.ts | pipe-sanitize-codex.ts` を実行し `sanitized.json` を生成する。`raw_text` 抽出コードが `suspicious_patterns` をチェックし、非空なら `raw_text.txt` を空にして子 Codex に内容を読ませない。パターン未検出なら `raw_text` を抽出し、子 Codex が日本語要約を `summary.txt` に書き出す。親側は `merge-summary-codex.ts` で `sanitized.json` + `summary.txt` を結合する。`fetch_success=false` の場合は pipe-sanitize が fail-closed する

### `pipe-sanitize-codex.ts`

direct HTTP fetcher の出力 JSON を sanitize 前に検証する。

- stdin 全体を JSON として parse する
- `url`, `raw_html`, `raw_text`, `fetch_success`, `error_message` の型を検証する
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

テストは `http-fetch-codex.ts`、`pipe-sanitize-codex.ts`、`merge-summary-codex.ts` の in-source testing を主とし、外部サイトに依存する E2E は手動確認に留める。Zenn 実 URL を固定した自動テストは、外部サイト・DNS・ネットワーク制約に依存するため追加しない。

## 10. 設計上の割り切り

- **JavaScript 実行はしない**: SPA で本文がクライアント実行後にしか現れないページは取得できない場合がある
- **本文抽出は素朴な実装から始める**: 初期実装では追加依存を避け、HTML の一般的な本文候補 (`article`, `main`, JSON-LD 等) と text / JSON / XML を対象にする
- **HTTP fetcher に必要なネットワーク権限は環境依存**: agent / sandbox / CI のネットワーク policy で外部 GET が禁止されている場合は失敗する
- **SSRF 対策は必須**: URL と全リダイレクト先の検証、DNS 解決後 IP の拒否リスト、サイズ・timeout 上限を fetcher 側で強制する
- **DNS rebinding は残リスク**: Node.js 標準 `fetch()` では検証済み IP への接続 pinning ができない。完全に塞ぐ場合は低レベル HTTP/TLS 実装への切り替えが必要
- **main Claude はサニタイズ済み全文を見る**: 自然言語ベースの説得・誘導までは静的サニタイザでは防げない
- **完全防御ではない**: 要確認時に親 Claude が出力を抑制する運用が前提

## 11. 将来的な拡張候補

- **HTML 抽出ライブラリの導入**: 標準実装で本文抽出品質が不足する場合、`jsdom` / `linkedom` / Readability 系を比較検討する
- **サイト固有 extractor**: Zenn など構造が安定しているサイトについて、汎用 extractor の前後に小さなサイト固有処理を追加する
- **HTTP cache / retry policy**: 一時的な DNS / timeout 失敗に対する限定的 retry を導入する
- **guarded-websearch-codex**: 検索結果一覧向けに同じ構造を展開する
- **要約専用 invocation の権限分離と二段隔離**: 現在は fetch + sanitize + 要約を単一の `codex exec` (`danger-full-access`) で実行しているが、HTTP fetcher を取得専用、要約フェーズを別の `codex exec` に分離し、要約側のコマンド実行権限を制限する構成に移行する。v0.139.0 の調査で `read-only` sandbox の初期化自体は成功することが判明したが、シェルコマンドのネットワークアクセスが遮断されるため、要約のみの invocation（ネットワーク不要）であれば `read-only` で実行可能な見込みがある
- **HTTP 取得の `read-only` 化**: 現在の `node http-fetch-codex.ts` はシェルコマンド経由のため `read-only` sandbox のネットワーク制限に抵触する。Codex の組み込み `web_search` ツールのように sandbox 制限を受けないサーバーサイド取得手段（組み込み web fetch ツール等）が利用可能になれば、HTTP 取得も `read-only` で実行できる可能性がある

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
