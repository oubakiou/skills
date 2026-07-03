# gh issue — Issue 操作

checkout 外から操作する場合は `-R owner/repo` を付ける。

## 作成

```bash
gh issue create --title "bug: X fails" --body-file - <<'EOF'
## 再現手順
...
EOF
```

- `--title` と `--body`（または `--body-file`）を両方指定しないと対話プロンプトになる
- 主要フラグ: `--label <name>` / `--assignee @me` / `--milestone <name>` /
  `--project <title>` / `--template <name>`（issue template を下敷きにする）

## 一覧・検索

```bash
gh issue list --json number,title,labels,assignees,updatedAt
gh issue list --state all --label bug --assignee @me --limit 50
gh issue list --search "sort:created-desc error in:title"
gh issue view 123 --json title,body,comments
gh issue view 123 --comments
gh issue status    # 自分に関係する issue の俯瞰
```

`--search` は GitHub の検索構文（qualifier）をそのまま使える。
リポジトリ横断の検索は [search.md](search.md) の `gh search issues` を使う。

## コメント・編集

```bash
gh issue comment 123 --body-file - <<'EOF'
...
EOF
gh issue edit 123 --add-label bug --remove-label triage --title "new title"
gh issue edit 123 456 --add-assignee @me   # 複数 issue を一括編集できる
```

## クローズ・再オープン

```bash
gh issue close 123 --reason completed --comment "fixed in #124"
gh issue close 123 --reason "not planned"
gh issue close 123 --duplicate-of 100
gh issue reopen 123
```

`--reason` は `completed` / `not planned` / `duplicate` のいずれか。

## issue からブランチを作る

```bash
gh issue develop 123 --checkout                 # ブランチ作成して checkout
gh issue develop 123 --name fix/issue-123 --base main
gh issue develop 123 --list                     # 既にリンクされたブランチの一覧
```

issue とブランチが GitHub 上でリンクされ、PR マージ時に issue が自動クローズされる
開発フローに乗る。
