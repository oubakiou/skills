# 既知のプロンプトインジェクションパターン集

このドキュメントは sanitize.ts で検出対象とする既知パターンを記録・管理するためのものである。
新しいモデルや攻撃手法が公開された際にパターンを見直し、必要に応じて sanitize.ts の `LLM_MARKERS` を更新する。

パターン定義は `guarded-webfetch-claude/references/injection_patterns.md` と共通。
本スキルは sanitize.ts を guarded-webfetch-claude から import して使用するため、パターンの更新は guarded-webfetch-claude 側で一元管理する。

## 参照

- [guarded-webfetch-claude/references/injection_patterns.md](../../guarded-webfetch-claude/references/injection_patterns.md)

## 更新履歴

- 初期: guarded-webfetch-claude のパターンを共有参照として設定
