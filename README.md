# skills

LLM エージェント（Claude Code / Codex / Gemini CLI）向けのカスタムスキル集。

## スキル一覧

### guarded-webfetch 系 — URL 指定でのコンテンツ取得防御

| スキル                    | 隔離子プロセス                | 概要                                                                                                                                      |
| ------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `guarded-webfetch-claude` | Claude (`claude -p`)          | Claude の WebFetch ツールで URL コンテンツを取得しサニタイズ（[設計](.claude/skills/guarded-webfetch-claude/references/design-plan.md)）  |
| `guarded-webfetch-codex`  | Codex (`codex --search exec`) | Codex の sandbox 内で URL コンテンツを取得しサニタイズ（[設計](.claude/skills/guarded-webfetch-codex/references/design-plan.md)）         |
| `guarded-webfetch-gemini` | Gemini (`gemini -p`)          | Gemini の web_fetch ツールで URL コンテンツを取得しサニタイズ（[設計](.claude/skills/guarded-webfetch-gemini/references/design-plan.md)） |

### guarded-websearch 系 — Web 検索結果の取得防御

| スキル                     | 隔離子プロセス                | 概要                                                                                                                              |
| -------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `guarded-websearch-claude` | Claude (`claude -p`)          | Claude の WebSearch ツールで検索しサニタイズ（[設計](.claude/skills/guarded-websearch-claude/references/design-plan.md)）         |
| `guarded-websearch-codex`  | Codex (`codex --search exec`) | Codex の検索機能で検索しサニタイズ（[設計](.claude/skills/guarded-websearch-codex/references/design-plan.md)）                    |
| `guarded-websearch-gemini` | Gemini (`gemini -p`)          | Gemini の google_web_search ツールで検索しサニタイズ（[設計](.claude/skills/guarded-websearch-gemini/references/design-plan.md)） |

### その他

| スキル          | 概要                                                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `skill-creator` | スキルの新規作成・編集・eval 実行・パフォーマンス測定 ([anthropics/skills](https://github.com/anthropics/skills) からインストール) |

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
  .claude/skills/guarded-webfetch-claude/scripts/quarantine-fetch.sh '<URL>'
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
vp test .claude/skills/guarded-webfetch-gemini/scripts/pipe-sanitize-gemini.ts
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

```
.claude/skills/
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
```

## ライセンス

[MIT](LICENSE)
