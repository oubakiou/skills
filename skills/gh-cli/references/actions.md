# gh run / gh workflow / gh cache — GitHub Actions

checkout 外から操作する場合は `-R owner/repo` を付ける。

## 実行 (run) の確認

```bash
gh run list --json databaseId,displayTitle,status,conclusion,headBranch --limit 10
gh run list --branch main --status failure
gh run list --workflow ci.yml --commit <SHA>
```

- run の ID は JSON フィールド `databaseId`（`id` ではない）
- `--status` の値: `queued|completed|in_progress|requested|waiting|pending|action_required|cancelled|failure|neutral|skipped|stale|startup_failure|success|timed_out`

```bash
gh run view 12345 --json status,conclusion,jobs
gh run view 12345 --log-failed        # 失敗したステップのログだけ表示
gh run view 12345 --job <job-id> --log
gh run view 12345 --exit-status       # run が失敗していれば非ゼロ終了
```

失敗調査の定石: `gh run list` で失敗 run の `databaseId` を取り、
`gh run view <id> --log-failed` で失敗ステップのログだけを読む。
全ログ (`--log`) は巨大になりがちなので `--log-failed` を優先する。

## 完了待ち

```bash
gh run watch <run-id> --exit-status --compact --interval 10
```

- `--exit-status` で run 失敗が exit code に反映される（CI ゲートとして使える）
- `--compact` で関連・失敗ステップのみ表示になり出力が減る
- push 直後は run がまだ作られていないことがある。`gh run list --commit <SHA>` で
  run の出現を確認してから watch する

## 再実行・キャンセル・アーティファクト

```bash
gh run rerun 12345 --failed           # 失敗した job のみ再実行
gh run rerun 12345 --debug            # デバッグログ付きで再実行
gh run cancel 12345
gh run download 12345 --name build-output --dir .temp/artifacts/
gh run download 12345 --pattern '*-report'
```

## workflow の操作

```bash
gh workflow list --json name,id,state
gh workflow view ci.yml --yaml        # workflow 定義の確認
gh workflow run ci.yml --ref my-branch -f param1=value1
echo '{"param1":"value1"}' | gh workflow run ci.yml --json
gh workflow enable ci.yml
gh workflow disable ci.yml
```

- `workflow run` は `workflow_dispatch` トリガーを持つ workflow のみ起動できる
- inputs は `-f key=value` または `-F key=value`（`@file` でファイル内容を渡せる）
- 起動後の run ID は直接返らない。`gh run list --workflow ci.yml --limit 1` で拾う

## Actions キャッシュ

```bash
gh cache list --json id,key,sizeInBytes
gh cache delete <cache-id | key>
gh cache delete --all
```
