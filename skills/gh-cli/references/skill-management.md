# gh skill — agent skill の管理（preview 機能）

LLM エージェント向けスキル（[Agent Skills 仕様](https://agentskills.io/specification)）を
GitHub リポジトリから検索・インストール・更新・公開する。preview 機能のため
予告なく変わりうる。迷ったら `gh skill <sub> --help` で現行仕様を確認する。

サブコマンド: `search` / `preview` / `install` / `update` / `publish`
（エイリアス: `gh skills`、`install` は `gh skill add` でも可）

## 検索・内容確認

```bash
gh skill search terraform --json repo,skillName,description,stars
gh skill search terraform --owner hashicorp --limit 5
gh skill preview owner/repo skill-name           # インストールせず SKILL.md を閲覧
gh skill preview owner/repo skill-name@v1.2.0
```

## インストール

```bash
gh skill install owner/repo skill-name --agent claude-code --scope project
gh skill install owner/repo skill-name@v1.2.0    # バージョン指定
gh skill install owner/repo skills/author/skill-name   # パス指定（大規模リポジトリで高速）
gh skill install ./local-repo skill-name --from-local  # ローカルディレクトリから
gh skill install owner/repo skill-name --pin v2.0.0 --force
```

重要な注意点:

- **非対話実行時のデフォルト agent は `github-copilot`**。Claude Code 向けに
  入れるなら `--agent claude-code` を必ず明示する
- デフォルト scope は `project`。インストール先はホストごとに異なる:

| agent                                         | project scope    | user scope          |
| --------------------------------------------- | ---------------- | ------------------- |
| `github-copilot`                              | `.agents/skills` | `~/.copilot/skills` |
| `claude-code`                                 | `.claude/skills` | `~/.claude/skills`  |
| `cursor` / `codex` / `gemini` / `antigravity` | `.agents/skills` | 各ホスト固有        |

- バージョン未指定時は「最新のタグ付き release → default branch HEAD」の順で解決
- 既存スキルの上書きは `--force`（無いと確認プロンプトになる）
- `--dir <path>` で任意ディレクトリにも入れられる（`--agent`/`--scope` より優先）
- インストール時に source tracking メタデータが frontmatter に注入され、
  `gh skill update` が差分検出に使う

## 更新

```bash
gh skill update --dry-run        # 更新有無の確認だけ（読み取り専用）
gh skill update --all            # 全スキルをプロンプトなしで更新
gh skill update skill-a skill-b  # 特定スキルのみ
gh skill update --force --all    # ローカル改変を元の内容で上書き復元
gh skill update --unpin          # pin を解除して最新へ
```

- 既知の全ホストディレクトリ（project / user 両 scope）を自動スキャンする
- `--pin` でインストールしたスキルはスキップされる（`--unpin` で対象化）
- 非対話では `--all` か `--dry-run` を付ける（裸だと確認プロンプトになる）

## 公開 (publish)

リポジトリの skills を仕様検証し、GitHub release として公開する。

```bash
gh skill publish --dry-run       # 検証のみ（公開しない）
gh skill publish --tag v1.0.0    # 非対話で公開
gh skill publish --fix           # インストールメタデータの除去等を自動修正
```

- スキル発見規約: `skills/*/SKILL.md`、`skills/{scope}/*/SKILL.md`、
  ルートの `*/SKILL.md`、`plugins/{scope}/skills/*/SKILL.md`
- 検証内容: 命名規則（agentskills.io 準拠、ディレクトリ名と name の一致）、
  必須 frontmatter（`name`, `description`）、`allowed-tools` が文字列であること、
  install メタデータ（`metadata.github-*`）が残っていないこと
- `--tag` なしの publish は対話フロー（topic 追加 → tag 選択 → release 作成）に
  なるため、**非対話では `--tag vX.Y.Z` が必須**
- 公開すると `agent-skills` topic とリリースが作られ、`gh skill install` /
  `gh skill search` で見つかるようになる
