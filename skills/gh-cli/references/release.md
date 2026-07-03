# gh release — リリース管理

checkout 外から操作する場合は `-R owner/repo` を付ける。

## 作成

```bash
# notes を GitHub に自動生成させる（最も手軽）
gh release create v1.2.3 --generate-notes

# notes をファイルから渡す（推奨: 内容を制御できる）
gh release create v1.2.3 --title "v1.2.3" --notes-file .temp/notes.md

# アセットを同時にアップロード
gh release create v1.2.3 --notes-file notes.md dist/app-linux-amd64 dist/app-darwin-arm64
```

- `--notes` / `--notes-file` / `--generate-notes` / `--notes-from-tag` の
  いずれも指定しないと対話プロンプトになる
- tag が未 push でもリリース作成時に作られる。既存 tag のみ許可したい場合は
  `--verify-tag`（tag がリモートに無ければ中断）
- 主要フラグ: `--draft` / `--prerelease` / `--target <branch|SHA>` /
  `--latest` / `--latest=false` / `--notes-start-tag <tag>`（自動生成の起点）/
  `--fail-on-no-commits`（前リリースから commit が無ければ失敗）

## アセットの管理

```bash
gh release upload v1.2.3 dist/*.tar.gz --clobber   # 同名アセットは上書き
gh release download v1.2.3 --pattern '*-linux-*' --dir .temp/
gh release download v1.2.3 --output - > file.bin    # 単一アセットを stdout へ
gh release download v1.2.3 --archive tar.gz         # ソースアーカイブ
```

`download` は tag 省略で最新リリースが対象。`--skip-existing` / `--clobber` で
既存ファイルの扱いを制御する。

## 確認・編集・削除

```bash
gh release list --json tagName,isLatest,isDraft,publishedAt
gh release view v1.2.3 --json tagName,body,assets
gh release edit v1.2.3 --notes-file notes.md        # notes の差し替え
gh release edit v1.2.3 --draft=false                # draft を公開
gh release delete v1.2.3 --yes                      # 確認プロンプト抑止
gh release delete v1.2.3 --yes --cleanup-tag        # git tag も削除
```

`delete` はデフォルトで確認プロンプトが出るため、非対話では `--yes` が必須。
