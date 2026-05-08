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

| スキル                    | 隔離子プロセス                | 概要                                                                                                                              |
| ------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `guarded-webfetch-claude` | Claude (`claude -p`)          | Claude の WebFetch ツールで URL コンテンツを取得しサニタイズ（[設計](skills/guarded-webfetch-claude/references/design-plan.md)）  |
| `guarded-webfetch-codex`  | Codex (`codex --search exec`) | Codex の sandbox 内で URL コンテンツを取得しサニタイズ（[設計](skills/guarded-webfetch-codex/references/design-plan.md)）         |
| `guarded-webfetch-gemini` | Gemini (`gemini -p`)          | Gemini の web_fetch ツールで URL コンテンツを取得しサニタイズ（[設計](skills/guarded-webfetch-gemini/references/design-plan.md)） |

### guarded-websearch 系 — Web 検索結果の取得防御

| スキル                     | 隔離子プロセス                | 概要                                                                                                                      |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `guarded-websearch-claude` | Claude (`claude -p`)          | Claude の WebSearch ツールで検索しサニタイズ（[設計](skills/guarded-websearch-claude/references/design-plan.md)）         |
| `guarded-websearch-codex`  | Codex (`codex --search exec`) | Codex の検索機能で検索しサニタイズ（[設計](skills/guarded-websearch-codex/references/design-plan.md)）                    |
| `guarded-websearch-gemini` | Gemini (`gemini -p`)          | Gemini の google_web_search ツールで検索しサニタイズ（[設計](skills/guarded-websearch-gemini/references/design-plan.md)） |

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

スキルの編集対象は `skills/` 配下のみ。`.claude/skills/` は dogfooding (この repo を Claude Code で開いた際に自スキルを読み込ませる) のためのインストール先で、`local_setup.sh` が `gh skill install --from-local` で `skills/` から取り込む。`.gitignore` 対象。

```
skills/                         # canonical (編集・公開対象)
  <skill-name>/
    SKILL.md                    # スキル定義 (フロントマター + 実行フロー)
    references/
      design-plan.md            # 設計計画・脅威モデル・割り切り
      *.toml / *.json           # Policy / Schema 等の設定ファイル
    scripts/
      check-node-version.sh     # Node.js バージョン事前チェック
      quarantine-*.sh           # 隔離プロセス起動のエントリポイント
      pipe-sanitize-*.ts        # パイプ接続のサニタイザ (テスト内蔵)
      sanitize.ts               # テキストサニタイズ (共有 or re-export)

.claude/skills/                 # 生成物 (.gitignore 対象、local_setup.sh で生成)
  <skill-name>/...              # skills/ から gh skill install --from-local で取得
  skill-creator/                # gh skill install で導入される外部 skill
```

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
