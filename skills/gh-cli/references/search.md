# gh search — GitHub 横断検索

リポジトリを跨いだ検索に使う。単一リポジトリ内の issue/PR 検索は
`gh issue list --search` / `gh pr list --search` の方が手軽。

すべてのサブコマンドで `--json <fields>` / `--jq` / `--limit` が使える。
クエリには GitHub の検索構文（qualifier）をそのまま書ける。

## リポジトリ検索

```bash
gh search repos "vector database" --language go --stars ">100" \
  --json fullName,description,stargazersCount --limit 10
gh search repos --owner my-org --topic cli
```

## issue / PR 検索

```bash
gh search issues "memory leak" --repo cli/cli --state open --json number,title,url
gh search issues --author @me --created ">2026-01-01"
gh search prs "fix auth" --repo cli/cli --merged --json number,title
gh search prs --review-requested @me --state open
```

## コード検索

```bash
gh search code "http.DefaultClient" --repo cli/cli --json path,repository
gh search code "def sanitize" --language python --owner my-org
gh search code "TODO" --filename "*.ts" --match path
```

- コード検索は認証必須で、対象はデフォルトブランチのみ
- `--match file|path` で「ファイル内容」か「パス」かを制限できる

## コミット検索

```bash
gh search commits "fix panic" --repo cli/cli --json sha,commit
gh search commits --author-name "monalisa" --committer-date ">2026-01-01"
```

## 補足

- 検索 API には独自の rate limit がある。大量の検索を回すときは間隔を空ける
- 空白を含むクエリはクォートする
- Web の検索 UI 相当の細かい qualifier（`in:title` 等）はクエリ文字列側に書く:
  `gh search issues 'error in:title'`
