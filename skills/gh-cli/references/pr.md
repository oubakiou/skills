# gh pr — Pull Request 操作

`[<number> | <url> | <branch>]` を省略すると「現在のブランチに紐づく PR」が対象になる。
checkout 外から操作する場合は `-R owner/repo` を付ける。

## 作成

```bash
# 明示的に title/body を指定（推奨）
gh pr create --title "feat: add X" --body-file - <<'EOF'
## Summary
- ...
EOF

# コミットメッセージから title/body を自動生成
gh pr create --fill            # 全コミットから生成
gh pr create --fill-first      # 先頭コミットのみ
gh pr create --fill-verbose    # コミットの message + body を展開
```

- ブランチが push 済みでなくても `gh pr create` が push を提案するプロンプトを
  出すことがある。**先に `git push -u origin <branch>` を済ませておく**のが確実
- title も `--fill` 系も指定しないと対話プロンプトになりハングする
- 主要フラグ: `--base <branch>` / `--head <branch>` / `--draft` /
  `--reviewer <handle>` / `--assignee @me` / `--label <name>` / `--milestone <name>`
- `--dry-run` は PR を作らず内容だけ表示する（ただし git の push は発生しうる）
- 途中で失敗した場合は `--recover <file>` で入力を復元できる

## 一覧・確認

```bash
gh pr list --json number,title,headRefName,author,updatedAt
gh pr list --state closed --author @me --limit 50
gh pr view 123 --json title,body,state,mergeable,reviews,statusCheckRollup
gh pr view --comments        # コメントを読む
gh pr diff 123               # diff を表示
gh pr status                 # 自分に関係する PR の俯瞰
```

## checkout

```bash
gh pr checkout 123   # gh 初期設定の alias「gh co 123」でも可（config 由来なので無い環境もある）
```

fork からの PR でもローカルブランチとして取得できる。

## CI チェックの確認

```bash
gh pr checks 123 --json name,state,link
gh pr checks --watch --fail-fast   # 完了まで待機、最初の失敗で即終了
gh pr checks --required            # required チェックのみ
```

`gh pr checks` はチェック失敗時に非ゼロ exit になるため、CI 通過の
ゲートとしてそのまま使える。失敗したチェックの詳細ログは
[actions.md](actions.md) の `gh run view --log-failed` で追う。

## レビュー・コメント

```bash
gh pr review 123 --approve
gh pr review 123 --request-changes --body-file - <<'EOF'
...
EOF
gh pr review 123 --comment --body "LGTM with nits"

gh pr comment 123 --body-file - <<'EOF'
...
EOF
gh pr comment 123 --edit-last --body "updated"   # 自分の最後のコメントを編集
gh pr comment 123 --edit-last --create-if-none --body "..."  # なければ新規作成
```

`--approve` / `--request-changes` / `--comment` のいずれかを必ず指定する。
指定しないと対話プロンプトになる。

## レビュースレッド（コメントツリー）の読み取り・返信

既存のレビューコメントを読み、文脈を踏まえて既存スレッドに返信をぶら下げる
ワークフロー。インラインレビューコメントのスレッド操作には gh のネイティブ
サブコマンドがなく、`gh api` を使う（[api-and-json.md](api-and-json.md) 参照）。

PR には 2 種類のコメントがあることに注意:

- **会話コメント**（PR 本文下）: `gh pr view 123 --comments` や
  `gh pr comment` で読み書きできる
- **インラインレビューコメント**（diff 上のスレッド）: 以下の `gh api` で扱う

```bash
# インラインレビューコメントを全件取得（スレッド構造は in_reply_to_id で辿る）
gh api repos/{owner}/{repo}/pulls/123/comments --paginate \
  --jq '.[] | {id, in_reply_to_id, path, line, user: .user.login, body}'
```

`in_reply_to_id` が `null` のコメントがスレッドの起点。返信はその起点 ID に
ぶら下げる（返信の ID を指定すると失敗する）:

```bash
gh api repos/{owner}/{repo}/pulls/123/comments/<起点comment_id>/replies -f body='返信本文'
```

スレッドの resolve 状態の確認・変更は REST に無いため GraphQL を使う:

```bash
gh api graphql -F owner='{owner}' -F name='{repo}' -F number=123 -f query='
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes {
            id isResolved isOutdated path
            comments(first: 20) { nodes { databaseId author { login } body } }
          }
        }
      }
    }
  }
'
# resolve する場合
gh api graphql -f query='
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } }
  }
' -f threadId=<reviewThreads の node id>
```

GraphQL の `comments.nodes[].databaseId` が REST の comment `id` に対応する。
「既存レビューを読んでから自分のレビューを書く」場合は、まず上記でスレッドを
読み、指摘済みの内容と重複しない新規指摘は `gh pr review` / 新規インライン
コメントで、既存指摘への応答は `/replies` で返す。

## マージ

```bash
gh pr merge 123 --squash --delete-branch
gh pr merge 123 --merge          # merge commit
gh pr merge 123 --rebase
gh pr merge 123 --squash --auto  # 要件が揃い次第の自動マージを予約
gh pr merge 123 --admin          # branch protection を管理者権限で上書き
```

- merge 方式（`--merge`/`--squash`/`--rebase`）を必ず指定する。省略すると対話プロンプトになる
- `--auto` はリポジトリ側で auto-merge が有効な場合のみ使える
- `--match-head-commit <SHA>` で「レビュー後に commit が積まれていないこと」を保証できる

## 状態変更

```bash
gh pr ready 123          # draft を解除
gh pr ready 123 --undo   # draft に戻す
gh pr close 123 --comment "reason" --delete-branch
gh pr reopen 123
gh pr edit 123 --add-label bug --add-reviewer someone --title "new title"
```
