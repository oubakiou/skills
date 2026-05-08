# 既知のプロンプトインジェクションパターン集

このドキュメントは sanitize.ts で検出対象とする既知パターンを記録・管理するためのものである。
新しいモデルや攻撃手法が公開された際にパターンを見直し、必要に応じて sanitize.ts の `LLM_MARKERS` を更新する。

sanitize.ts の正本は `shared/sanitize/sanitize.ts` にあり、本スキルの `scripts/sanitize.ts` は `scripts/sync-shared.ts` で配布された自動生成コピー（webfetch-claude を含む全 6 skill で同一実装）。パターン定義のドキュメント側は webfetch-claude 側を一次ソースとして共通参照する。

## 参照

- 実装の正本: [`shared/sanitize/sanitize.ts`](../../../shared/sanitize/sanitize.ts)
- パターン定義の一次ソース: [guarded-webfetch-claude/references/injection_patterns.md](../../guarded-webfetch-claude/references/injection_patterns.md)
- 更新手順は webfetch-claude 側の「更新運用」セクションを参照

## 更新履歴

- 初期: guarded-webfetch-claude のパターンを共有参照として設定
- shared 化: sanitize.ts の正本を `shared/sanitize/sanitize.ts` に集約し、各 skill は自動生成コピーを保持する方式に移行
