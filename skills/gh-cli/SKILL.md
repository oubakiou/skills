---
name: gh-cli
license: MIT
description: >-
  GitHub CLI (gh) をエージェントが非対話で安全に使うための実践パターン集。
  PR の作成・レビュー・マージ、issue 管理、リリース作成、GitHub Actions の実行確認・失敗調査、
  gh api での REST/GraphQL 呼び出し、リポジトリ操作、GitHub 上の検索、agent skill の
  インストール・公開 (gh skill) を扱う。ユーザーが「PR を作って」「issue を立てて」
  「リリースして」「CI の結果を見て」「GitHub で検索して」「スキルをインストールして」など
  GitHub 操作に言及したら、gh コマンドを組み立てる前にこのスキルを参照すること。
  gh は対話プロンプトでハングしたり人間向け出力が不安定だったりするため、
  単純そうな gh 操作でも発動する側に倒す。
---

# gh-cli

GitHub CLI (`gh`) をエージェントが使うためのスキル。gh 2.90.0 系の help と
[公式マニュアル](https://cli.github.com/manual/) を元にしている。

help 全文の複製はしない。個々のフラグの完全な一覧が必要なら
`gh <command> <subcommand> --help` を実行するのが常に最新で正確。
このスキルは「エージェントが踏みやすい罠」と「頻出レシピ」に絞る。

## 大原則

### 1. 対話プロンプトを発生させない

gh は引数が足りないと対話プロンプトや `$EDITOR` を開き、エージェントはそこでハングする。

- 必須情報（title / body / tag 等）は必ずフラグで渡す。`gh pr create` を裸で実行しない
- `-e/--editor` フラグは使わない（エディタが開く）
- `-w/--web` フラグは使わない（ブラウザが開く）
- 破壊的操作の確認プロンプトは `--yes` 等の明示フラグで抑止する
- 保険として `GH_PROMPT_DISABLED=1` を設定すると、対話プロンプトが必要な場面で
  ハングせずエラー終了になる

複数行の body はインライン文字列より `--body-file` が安全（クォート事故を防ぐ）:

```bash
gh pr create --title "feat: add X" --body-file - <<'EOF'
## Summary
...
EOF
```

### 2. 出力は --json + --jq で機械的に取る

人間向けのデフォルト出力（表形式・色付き）を文字列パースしない。
`--json` 対応コマンドでは必ず `--json <fields>` を使う。

- 利用可能なフィールド名は `--json` を値なしで実行するとエラーメッセージに一覧が出る
- 絞り込みは `--jq` を併用（jq 本体のインストール不要で gh に内蔵）

```bash
gh pr list --json number,title,author --jq '.[] | "\(.number)\t\(.title)"'
```

### 3. リポジトリ指定

カレントディレクトリが対象リポジトリの checkout でない場合は
`-R owner/repo` フラグか環境変数 `GH_REPO=owner/repo` を指定する。
checkout 内なら省略してよい。

### 4. 認証と exit code

- 認証状態の確認: `gh auth status`。CI 等では `GH_TOKEN` 環境変数が最優先で使われる
- exit code: `0` 成功 / `1` 失敗 / `2` キャンセル / `4` 認証が必要
- `gh run watch --exit-status` や `gh pr checks` のように、対象の失敗を
  exit code に反映させるフラグを持つコマンドがある（各リファレンス参照）

## タスク別リファレンス

該当する作業を始める前に対応するファイルを読むこと。

| やりたいこと                                               | リファレンス                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| PR の作成・確認・レビュー・マージ・CI チェック             | [references/pr.md](references/pr.md)                             |
| issue の作成・検索・更新・ブランチ連携                     | [references/issue.md](references/issue.md)                       |
| リリースの作成・アセット管理・ダウンロード                 | [references/release.md](references/release.md)                   |
| GitHub Actions の実行確認・失敗調査・再実行・workflow 起動 | [references/actions.md](references/actions.md)                   |
| REST/GraphQL API 呼び出し、--json/--jq/--template の詳細   | [references/api-and-json.md](references/api-and-json.md)         |
| リポジトリの作成・clone・fork・設定変更                    | [references/repo.md](references/repo.md)                         |
| リポジトリ・issue・PR・コード・コミットの横断検索          | [references/search.md](references/search.md)                     |
| agent skill の検索・インストール・更新・公開 (gh skill)    | [references/skill-management.md](references/skill-management.md) |

## 頻出ワンライナー

```bash
# 現在のブランチの PR を確認
gh pr view --json number,title,state,url

# CI が全部通るまで待ち、失敗したら非ゼロで終了
gh pr checks --watch --fail-fast

# 直近の workflow run の失敗ログだけ見る
gh run list --limit 1 --json databaseId --jq '.[0].databaseId' | xargs -I{} gh run view {} --log-failed

# リリースを notes 自動生成で作成
gh release create v1.2.3 --generate-notes

# REST API を呼んで必要なフィールドだけ抽出
gh api repos/{owner}/{repo}/releases --jq '.[].tag_name'
```
