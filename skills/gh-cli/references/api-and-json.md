# gh api と JSON 出力 (--json / --jq / --template)

## --json / --jq / --template（多くのコマンドで共通）

```bash
gh pr list --json number,title,author            # JSON で出力
gh pr list --json number,title --jq '.[].title'  # jq で絞り込み
gh pr list --json                                # ← フィールド名一覧がエラーで出る
```

- `--jq` / `--template` は `--json <fields>` と併用必須
- `--jq` は gh 内蔵の jq 実装で動く（システムに jq が無くても使える）
- `--template` は Go template 構文。`tablerow` / `timeago` / `truncate` /
  `join` / `pluck` 等の補助関数が使える（詳細は `gh help formatting`）

```bash
gh pr list --json number,title,updatedAt --template \
  '{{range .}}{{tablerow (printf "#%v" .number) .title (timeago .updatedAt)}}{{end}}'
```

## gh api — REST API

エンドポイントの `{owner}` `{repo}` `{branch}` はカレントリポジトリ
（または `GH_REPO`）の値に自動置換される。

```bash
gh api repos/{owner}/{repo}                       # GET
gh api repos/{owner}/{repo}/issues/123/comments -f body='Hi'   # パラメータありは自動で POST
gh api -X PATCH repos/{owner}/{repo} -F delete_branch_on_merge=true
gh api -X DELETE repos/{owner}/{repo}/labels/bug
gh api repos/{owner}/{repo}/issues --jq '.[].title'
```

### パラメータの型

- `-f key=value`: 常に文字列
- `-F key=value`: 型変換あり — `true`/`false`/`null`/整数は JSON 型に、
  `@path` はファイル内容（`@-` で stdin）、`{owner}` 等のプレースホルダも展開
- ネスト: `key[subkey]=value`、配列: `key[]=v1 key[]=v2`、空配列: `key[]`
- JSON body を丸ごと渡す: `--input body.json`（`-` で stdin）。
  このとき `-f`/`-F` はクエリ文字列に回る

### GET でクエリパラメータを渡す

パラメータを付けるとデフォルトが POST に変わるため、検索系 API では明示する:

```bash
gh api -X GET search/issues -f q='repo:cli/cli is:open label:bug'
```

### ページネーション

```bash
gh api --paginate repos/{owner}/{repo}/issues --jq '.[].number'
gh api --paginate --slurp repos/{owner}/{repo}/issues   # 全ページを 1 つの JSON 配列に
```

### GraphQL

```bash
gh api graphql -F owner='{owner}' -F name='{repo}' -f query='
  query($name: String!, $owner: String!) {
    repository(owner: $owner, name: $name) {
      releases(last: 3) { nodes { tagName } }
    }
  }
'
```

- `query` / `operationName` 以外の `-f`/`-F` は GraphQL 変数として渡る
- `--paginate` を使う場合は query が `$endCursor: String` 変数を受け取り
  `pageInfo { hasNextPage, endCursor }` を fetch している必要がある

### その他

- `--include` でレスポンスヘッダも表示（rate limit の確認等）
- `--silent` で body を出力しない（書き込み系で成功だけ確認したいとき）
- `--verbose` でリクエスト/レスポンス全体を表示（デバッグ用）
- `--cache 1h` でレスポンスをキャッシュ（同一リクエストの繰り返しに）

## 環境変数（エージェント運用で重要なもの）

| 変数                        | 用途                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| `GH_TOKEN` / `GITHUB_TOKEN` | 認証トークン。保存済み credential より優先                            |
| `GH_REPO`                   | `[HOST/]OWNER/REPO` 形式で対象リポジトリを指定（checkout 外での操作） |
| `GH_HOST`                   | GitHub Enterprise 等のホスト名                                        |
| `GH_PROMPT_DISABLED`        | 対話プロンプトを無効化（ハングの代わりにエラー終了）                  |
| `GH_PAGER`                  | ページャ指定。`cat` にすると確実に全文が stdout に出る                |
| `GH_DEBUG`                  | `1` で verbose、`api` で HTTP トラフィックも stderr に出力            |
| `NO_COLOR`                  | ANSI カラー無効化                                                     |

## exit code

`0` 成功 / `1` 失敗 / `2` キャンセル / `4` 認証が必要。
コマンドによって追加の exit code を持つことがある（`gh help exit-codes`）。
