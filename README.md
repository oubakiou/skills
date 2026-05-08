# skills

LLM エージェント（Claude Code / Codex / Gemini CLI）向けのカスタムスキル集。

## インストール

### 前提条件

- Node.js 23.6 以降 (パイプサニタイザ実行用)
- 導入するスキルに応じて、以下の CLI コマンドが PATH 上で実行可能であること:
  - `guarded-*-claude` を使うなら `claude` コマンド
  - `guarded-*-codex` を使うなら `codex` コマンド
  - `guarded-*-gemini` を使うなら `gemini` コマンド

### 例 1: `gh skill install` ([GitHub CLI](https://cli.github.com/manual/gh_skill_install))

GitHub Release ベースの公式ツール。事前に `gh auth login` が必要。

```bash
# gh skill installでの例
gh skill install oubakiou/skills guarded-webfetch-gemini --agent claude-code --scope project
gh skill install oubakiou/skills guarded-websearch-gemini --agent claude-code --scope project
```

### 例 2: `npx skills add` ([vercel-labs/skills](https://github.com/vercel-labs/skills#install-a-skill))

Node.js (`npx`) ベースのコミュニティツール。

```bash
# npx skills addでの例
npx skills add oubakiou/skills --skill guarded-webfetch-gemini --agent claude-code --yes
npx skills add oubakiou/skills --skill guarded-websearch-gemini --agent claude-code --yes
```

### 動作確認

Claude Code を起動した状態で URL 取得や Web 検索を要求すると、フロントマターの `description` に基づき該当スキルが自動発動する。スキル単体の挙動を手動で確認したい場合は隔離スクリプトを直接実行できる。

```bash
bash .claude/skills/guarded-webfetch-claude/scripts/quarantine-fetch.sh 'https://example.com'
```

## スキル一覧

### guarded-webfetch 系 — URL 指定でのコンテンツ取得防御

| スキル                    | 隔離子プロセス                                                      | 概要                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guarded-webfetch-claude` | Claude (`claude -p`)<br>既定モデル: `claude-sonnet-4-6`             | Claude の WebFetch ツールで URL コンテンツを取得しサニタイズ（[設計](skills/guarded-webfetch-claude/references/design-plan.md)）<br>- 短い日本語要約を返す傾向（実測 raw 約 600 文字）<br>- 出力言語が日本語で安定<br>- コードブロックは含めず要点のみ、トークン節約向き                                                               |
| `guarded-webfetch-codex`  | Codex (`codex --search exec`)<br>既定モデル: `gpt-5.4-mini`         | Codex の sandbox 内で URL コンテンツを取得しサニタイズ（[設計](skills/guarded-webfetch-codex/references/design-plan.md)）<br>- ほぼ原文を抽出（実測 raw 約 3,000–3,700 文字、コード片やタグも保持）<br>- 出力言語が日本語で安定<br>- 実行時間の再現性が高く後段で自前要約する用途向き                                                  |
| `guarded-webfetch-gemini` | Gemini (`gemini -p`)<br>既定モデル: `gemini-3.1-flash-lite-preview` | Gemini の web_fetch ツールで URL コンテンツを取得しサニタイズ（[設計](skills/guarded-webfetch-gemini/references/design-plan.md)）<br>- 整形要約に Sources 引用付き（実測 raw 約 1,900–2,000 文字）<br>- 出力言語が日本語/英語に揺れる場合あり<br>- arm64 環境では sandbox がスキップされ、実行時間のばらつき・タイムアウトが起きやすい |

### guarded-websearch 系 — Web 検索結果の取得防御

| スキル                     | 隔離子プロセス                                                      | 概要                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guarded-websearch-claude` | Claude (`claude -p`)<br>既定モデル: `claude-sonnet-4-6`             | Claude の WebSearch ツールで検索しサニタイズ（[設計](skills/guarded-websearch-claude/references/design-plan.md)）<br>- 結果件数が常に 10 件で安定<br>- 実ページ URL とタイトルをそのまま返す（webfetch 系へ直接連携可）<br>- 実行時間は約 23–26 秒                                                        |
| `guarded-websearch-codex`  | Codex (`codex --search exec`)<br>既定モデル: `gpt-5.4-mini`         | Codex の検索機能で検索しサニタイズ（[設計](skills/guarded-websearch-codex/references/design-plan.md)）<br>- 実行時間が最速（約 12–16 秒）<br>- 実ページ URL とタイトルを返す<br>- 結果件数は 4–7 件と変動あり、公式 docs に偏る傾向                                                                       |
| `guarded-websearch-gemini` | Gemini (`gemini -p`)<br>既定モデル: `gemini-3.1-flash-lite-preview` | Gemini の google_web_search ツールで検索しサニタイズ（[設計](skills/guarded-websearch-gemini/references/design-plan.md)）<br>- URL が Google の grounding-redirect 形式となり実 URL が直接得られない<br>- title はホスト名のみ、snippet は本文抜粋<br>- 0 件返却が起こり得る、arm64 環境では sandbox なし |

## 防御アーキテクチャ

guarded 系スキルは 3 層の防御を組み合わせてプロンプトインジェクションを緩和する。

```
main agent (Claude Code)
  └─ Bash: quarantine-*.sh "<url-or-query>"
       │
       │  ┌─────────────────────────────────┐
       │  │ 隔離子プロセス                   │  ← 層 1: プロセス分離 + ツール制限
       │  │ (claude -p / codex / gemini -p) │
       │  └──────────┬──────────────────────┘
       │             │ stdout (JSON)
       │             ▼
       │  ┌─────────────────────────────────┐
       │  │ pipe-sanitize-*.ts              │  ← 層 2: 静的サニタイズ
       │  │  Unicode 不可視文字除去          │
       │  │  LLM マーカー無害化             │
       │  └──────────┬──────────────────────┘
       │             │ サニタイズ済み JSON
       ▼
  main agent: flags に基づく安全性判定        ← 層 3: 行動制御 (ソフト)
```

1. **プロセス分離 + ツール制限 (ハード)** — 隔離子プロセスは許可されたツールのみ使用可能。生の Web コンテンツは子プロセス内に閉じ込められる
2. **静的サニタイズ (ハード)** — NFKC 正規化、不可視 Unicode 除去、LLM チャットテンプレートマーカーの `[FILTERED]` 置換をパイプ内で実行
3. **安全性フラグによる行動制御 (ソフト)** — `suspicious_patterns` 検出時はユーザー確認まで actionable な出力を抑制

**これは緩和策であり、完全防御ではない。** 各スキルの `references/design-plan.md` に脅威モデルと割り切りを記載している。

### 子プロセスごとの防御実装の比較

上記 3 層を、各 guarded 系スキルがどの仕組みで実現しているかをまとめる。webfetch 系の例で示すが、websearch 系も実装パターンは同じ（ツール固定対象が `WebSearch` / `google_web_search` に変わるのみ）。

| 観点                     | guarded-\*-claude                                               | guarded-\*-codex                                         | guarded-\*-gemini                                                        |
| ------------------------ | --------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| 子コマンド               | `claude -p`                                                     | `codex --search exec`                                    | `gemini -p`                                                              |
| 出力形式                 | `--output-format json`                                          | `--json` JSONL                                           | `-o json` 固定ラッパー                                                   |
| 出力スキーマ強制         | あり (`--json-schema`)                                          | あり (`--output-schema`)                                 | 無し（プロンプト指示 + 受信側検証）                                      |
| ツール固定               | `--allowedTools "WebFetch"` / `"WebSearch"`                     | プロンプト + sandbox（CLI 直の固定なし）                 | Policy Engine TOML で `*` deny + `web_fetch` / `google_web_search` allow |
| Sandbox                  | OS レベル sandbox なし (env + permission deny + cwd 切替の多層) | `--sandbox read-only` / `workspace-write` フォールバック | `--sandbox` + gVisor (runsc 利用可能時のみ)                              |
| MCP 制限                 | `ENABLE_CLAUDEAI_MCP_SERVERS=false` 等                          | プロンプトと sandbox で抑制                              | Policy で `mcp_*` deny                                                   |
| Memory 自動読込抑止      | `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`                              | デフォルトで読まれない                                   | cwd 切替で `GEMINI.md` を含まない位置に                                  |
| Max turns / タイムアウト | `--max-turns 3`                                                 | デフォルトの試行回数                                     | `timeout 60` (プロセスレベル 60 秒)                                      |
| ローカル fallback リスク | 無し                                                            | 無し                                                     | あり（`web_fetch` の URL API 失敗時）                                    |
| 認証                     | Claude.ai OAuth（親継承）または `ANTHROPIC_API_KEY`             | ChatGPT ログイン または `OPENAI_API_KEY`                 | Google アカウント OAuth または `GEMINI_API_KEY` / `GOOGLE_API_KEY` / ADC |
| ツール権限の強さ         | ハード                                                          | 準ハード                                                 | ハード（Policy Engine による強制）                                       |
| 出力スキーマ強度         | ハード                                                          | ハード                                                   | ソフト                                                                   |

総評:

- **ツール権限**: Gemini = Claude > Codex
- **出力スキーマ**: Claude = Codex > Gemini
- **Sandbox**: Gemini > Codex > Claude（OS レベル隔離が選べる）

## カスタマイズ

各 guarded 系スキルが隔離子プロセスへ渡すモデルは、環境変数で上書きできる。未設定時はスクリプト内の既定値が使用される。

| 環境変数       | 既定値                          | 対象スキル                            |
| -------------- | ------------------------------- | ------------------------------------- |
| `CLAUDE_MODEL` | `claude-sonnet-4-6`             | `guarded-{webfetch,websearch}-claude` |
| `CODEX_MODEL`  | `gpt-5.4-mini`                  | `guarded-{webfetch,websearch}-codex`  |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite-preview` | `guarded-{webfetch,websearch}-gemini` |

例:

```bash
CLAUDE_MODEL=claude-haiku-4-5-20251001 \
  bash .claude/skills/guarded-webfetch-claude/scripts/quarantine-fetch.sh '<URL>'
```

## 開発

### 前提条件

- Node.js 23.6 以降
- 使用する子プロセスに応じた CLI (`claude`, `codex`, `gemini`) がインストール済みであること

### devcontainer

このリポジトリには devcontainer 設定が含まれている。VS Code や GitHub Codespaces で開くと、`postCreateCommand` 経由で `local_setup.sh` が自動実行され、後述の手動セットアップと同じ結果になる。

### 手動セットアップ

```bash
# 依存パッケージのインストール
npm ci

# CLI のシンボリックリンク作成、skill-creator のインストール等
source local_setup.sh
```

### テスト

各スキルの TypeScript スクリプトは Vitest の [in-source testing](https://vitest.dev/guide/in-source) を使用している。

```bash
# 全テスト実行
vp test

# 特定スキルのテスト
vp test skills/guarded-webfetch-gemini/scripts/pipe-sanitize-gemini.ts
```

### lint / フォーマット

[vite-plus](https://viteplus.dev/) (`vp`) を使用。

```bash
# チェック + 自動修正
vp check --fix

# チェックのみ
vp check
```

### ディレクトリ構成

編集対象は役割によって 2 つに分かれる:

- **公開対象 (`skills/`)**: 各 skill の SKILL.md / references / 固有スクリプト (`pipe-sanitize-*.ts`, `quarantine-*.sh` 等) を編集する。`gh skill publish` でリリースされる canonical
- **共有実装の編集対象 (`shared/`)**: 複数 skill で共有する実装の正本 (`sanitize.ts`, `codex-jsonl.ts`)。ロジック更新はここで行い、`npm run sync-shared` で各 skill にコピーを配布する

**直接編集してはいけないファイル**: `skills/<skill-name>/scripts/sanitize.ts` と `skills/<skill-name>/scripts/codex-jsonl.ts` は `shared/` から `scripts/sync-shared.ts` で自動生成されたコピー。直接編集すると `.githooks/pre-commit` の `sync-shared:check` で検出されコミットがブロックされる。

`.claude/skills/` は dogfooding (この repo を Claude Code で開いた際に自スキルを読み込ませる) のためのインストール先で、`local_setup.sh` が `gh skill install --from-local` で `skills/` から取り込む。`.gitignore` 対象。

各 skill の `scripts/sanitize.ts` / `codex-jsonl.ts` は自動生成された実体コピーとして git 管理下に置かれるため、各 skill は self-contained で動作する（`gh skill install` 単独でインストール可能）。

凡例: 注釈なしのファイルは通常の編集対象。`⛔` は編集禁止 (自動生成)、`📦` はビルド生成物。

```
shared/                         # 共有実装の正本
  sanitize/
    sanitize.ts                 # テキストサニタイズ (全 6 skill 共通)
  codex-jsonl/
    codex-jsonl.ts              # Codex JSONL 抽出 (codex 系 2 skill 共通)

scripts/
  sync-shared.ts                # shared/ → 各 skill scripts/ へのコピー / 検証ツール

skills/                         # canonical (gh skill publish 対象)
  <skill-name>/
    SKILL.md                    # スキル定義 (フロントマター + 実行フロー)
    references/
      design-plan.md            # 設計計画・脅威モデル・割り切り
      *.toml / *.json           # Policy / Schema 等の設定ファイル
    scripts/
      check-node-version.sh     # Node.js バージョン事前チェック
      quarantine-*.sh           # 隔離プロセス起動のエントリポイント
      pipe-sanitize-*.ts        # パイプ接続のサニタイザ (テスト内蔵)
      sanitize.ts               # ⛔ shared/sanitize/sanitize.ts から自動生成
      codex-jsonl.ts            # ⛔ (codex 系のみ) shared/codex-jsonl/codex-jsonl.ts から自動生成

.claude/skills/                 # 📦 .gitignore 対象、local_setup.sh で生成
  <skill-name>/...              # skills/ から gh skill install --from-local で取得
  skill-creator/                # gh skill install で導入される外部 skill
```

`shared/` の正本を編集したら `npm run sync-shared` でコピーを再生成する。`.githooks/pre-commit` が以下の三段で保証する:

1. **編集前の整合性チェック** (`sync-shared:check`): generated コピーを直接編集していないかを検出
2. **lint 後の自動再同期** (`sync-shared`): `vp check --fix` が `shared/` を書き換えた場合にコピーを自動的に追従
3. **最終ドリフト検証** (`sync-shared:check`): 上記を経てもズレが残っていれば fail-closed でコミットをブロック

`skills/<skill-name>/` を編集した後で Claude Code から最新版を試すには、対象 skill を再インストールする:

```bash
gh skill install . <skill-name> --from-local --agent claude-code --scope project --force
```

### 公開 (gh skill publish)

このリポジトリは [`gh skill publish`](https://cli.github.com/manual/gh_skill_publish) でリリースできる。`skills/<skill-name>/SKILL.md` の配置と Agent Skills 仕様への準拠を満たすことが前提。

```bash
# 検証のみ
gh skill publish --dry-run

# 対話モードで公開 (タグ選択 + GitHub Release 作成)
gh skill publish

# 非対話モード
gh skill publish --tag vX.Y.Z
```

利用者は `gh skill install <owner>/<repo> <skill-name> --agent claude-code --scope project` で各自の `.claude/skills/` に導入する。

## ライセンス

[MIT](LICENSE)
