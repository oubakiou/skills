# gh repo — リポジトリ操作

## 作成

```bash
# 新規リポジトリ（リモートのみ）
gh repo create my-org/new-repo --private --description "..." --add-readme

# カレントのローカルリポジトリを元に作成して push
gh repo create my-org/new-repo --private --source . --push

# テンプレートから作成
gh repo create my-org/new-repo --public --template my-org/template-repo --clone
```

- 可視性フラグ（`--public` / `--private` / `--internal`）を必ず指定する。
  省略すると対話プロンプトになる
- `--gitignore <template>` / `--license <keyword>` で初期ファイルを追加できる
  （`--source` との併用は不可）

## clone・fork・確認

```bash
gh repo clone owner/repo             # git clone + upstream 設定
gh repo clone owner/repo -- --depth 1   # -- 以降は git clone に渡る
gh repo fork owner/repo --clone      # fork して clone、upstream も設定される
gh repo view owner/repo --json name,description,defaultBranchRef,visibility
gh repo list my-org --json name,visibility --limit 100
```

## 設定変更 (repo edit)

```bash
gh repo edit --delete-branch-on-merge --enable-auto-merge
gh repo edit --default-branch main
gh repo edit --add-topic cli --add-topic automation
gh repo edit --visibility private --accept-visibility-change-consequences
```

可視性の変更には `--accept-visibility-change-consequences` の明示が必須
（star / watcher が失われる等の副作用があるため）。

## fork の同期

```bash
gh repo sync                          # fork のカレント checkout を upstream に追従
gh repo sync owner/my-fork            # リモート同士で同期
gh repo sync --branch feature-x
gh repo sync --force                  # 分岐している場合に hard reset で追従
```

## 削除

`gh repo delete` は破壊的操作。`--yes` で確認を抑止できるが、
実行前に必ずユーザーの明示的な確認を取ること。
token に `delete_repo` スコープが必要（`gh auth refresh -s delete_repo`）。
