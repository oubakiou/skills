# Security Policy

## Supported Versions

最新の `main` ブランチおよび直近の GitHub Release タグのみをサポート対象とする。

| バージョン       | サポート状況   |
| ---------------- | -------------- |
| 最新 Release tag | サポート対象   |
| それ以前         | サポート対象外 |

## Reporting a Vulnerability

セキュリティ上の脆弱性を発見した場合は、**公開 Issue を作成せず**、以下の手順で非公開に報告してください。

1. GitHub の [Private vulnerability reporting](https://github.com/oubakiou/skills/security/advisories/new) から Security Advisory を作成する
2. 再現手順、影響範囲、可能であれば修正案を記載する

報告を受領後、通常 7 日以内に初回応答を行い、修正完了後に Security Advisory を通じて公開する。

## Scope

本リポジトリが提供するスキル（`skills/` 配下）およびビルド・同期スクリプト（`scripts/`、`shared/`）が対象。`node_modules/` 内の依存パッケージの脆弱性は、上流のパッケージに報告してください。

## Security Architecture

guarded 系スキルのプロンプトインジェクション防御アーキテクチャについては [README.md](README.md#防御アーキテクチャ) を参照。これは緩和策であり完全防御ではない点に留意すること。
