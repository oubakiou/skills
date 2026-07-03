# skills

LLM エージェント（Claude Code / Codex）向けのカスタムスキル集。

## インストール

### 前提条件

- Node.js 23.6 以降
- 導入するスキルに応じて、以下の CLI コマンドが PATH 上で実行可能であること:
  - `guarded-*-codex` を使うなら `codex` コマンドと `jq` コマンド

### 例 1: `gh skill install` ([GitHub CLI](https://cli.github.com/manual/gh_skill_install))

GitHub Release ベースの公式ツール。事前に `gh auth login` が必要。

```bash
# gh skill installでの例
gh skill install oubakiou/skills guarded-webfetch-codex --agent claude-code --scope project
gh skill install oubakiou/skills guarded-websearch-codex --agent claude-code --scope project
```

### 例 2: `npx skills add` ([vercel-labs/skills](https://github.com/vercel-labs/skills#install-a-skill))

Node.js (`npx`) ベースのコミュニティツール。

```bash
# npx skills addでの例
npx skills add oubakiou/skills --skill guarded-webfetch-codex --agent claude-code --yes
npx skills add oubakiou/skills --skill guarded-websearch-codex --agent claude-code --yes
```

## スキル一覧

### guarded-webfetch 系 — URL 指定でのコンテンツ取得防御

| スキル                   | 隔離取得層                                         | 概要                                                                                                                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `guarded-webfetch-codex` | Codex (`codex exec`) + Node.js direct HTTP fetcher | Codex 子プロセス内で Node.js 標準 `fetch()` により URL コンテンツを取得しサニタイズ（[設計](skills/guarded-webfetch-codex/references/design-plan.md)）<br>- Codex の `web_search` には依存しない<br>- HTTP / HTML / JSON / XML を決定的なコードで処理<br>- SSRF・redirect・サイズ・content-type を制限 |

### guarded-websearch 系 — Web 検索結果の取得防御

| スキル                    | 隔離子プロセス                                              | 概要                                                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guarded-websearch-codex` | Codex (`codex --search exec`)<br>既定モデル: `gpt-5.4-mini` | Codex の検索機能で検索しサニタイズ（[設計](skills/guarded-websearch-codex/references/design-plan.md)）<br>- 実行時間が最速（約 12–16 秒）<br>- 実ページ URL とタイトルを返す<br>- 結果件数は 4–7 件と変動あり、公式 docs に偏る傾向 |

### gh-cli — GitHub CLI (gh) の実践パターン集

| スキル   | 対象           | 概要                                                                                                                                                                                                                                                                     |
| -------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gh-cli` | gh 2.90 系準拠 | エージェントが gh を非対話で安全に使うためのレシピ集（公式マニュアルと gh help 出力を元に作成）<br>- PR / issue / release / GitHub Actions / api / 検索 / agent skill 管理 (`gh skill`) をカバー<br>- 対話プロンプト回避・`--json` + `--jq` 抽出・exit code 活用が大原則 |

### dataviz-svg — Vega-Lite による SVG/PNG チャート生成

| スキル        | レンダリング層                                | 概要                                                                                                                                                                                                                                                                                               |
| ------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataviz-svg` | Node.js + bundled Vega/Vega-Lite + resvg WASM | Vega-Lite JSON spec から SVG/PNG チャートを生成し Markdown に埋め込む（[設計](skills/dataviz-svg/references/design-plan.md)）<br>- Mermaid では難しい散布図・ヒートマップ・ヒストグラム・箱ひげ図等に対応<br>- `vega` / `vega-lite` / `resvg.wasm` / Noto Sans JP を同梱済みで追加インストール不要 |

## カスタマイズ

各 guarded 系スキルが隔離子プロセスへ渡すモデルは、環境変数で上書きできる。未設定時はスクリプト内の既定値が使用される。

| 環境変数      | 既定値         | 対象スキル                           |
| ------------- | -------------- | ------------------------------------ |
| `CODEX_MODEL` | `gpt-5.4-mini` | `guarded-{webfetch,websearch}-codex` |

`guarded-webfetch-codex` の子 Codex sandbox は `CODEX_FETCH_SANDBOX` で上書きできる。未設定時は `danger-full-access` を使用する。HTTP 取得の SSRF / redirect / content-type / size 制限は `http-fetch-codex.ts` 側で強制する。

例:

```bash
CODEX_MODEL=gpt-5.4-mini \
  bash .claude/skills/guarded-webfetch-codex/scripts/quarantine-fetch-codex.sh '<URL>'
```

## 開発

セットアップ・テスト・lint・ディレクトリ構成・リリース手順は [開発ガイド](docs/design/development.md) を参照。

## ライセンス

[MIT](LICENSE)

各スキルに同梱される third-party runtime asset はそれぞれのライセンスに従う。`dataviz-svg` の同梱 asset は [THIRD_PARTY_NOTICES.md](skills/dataviz-svg/THIRD_PARTY_NOTICES.md) を参照。
