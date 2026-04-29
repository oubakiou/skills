# 既知のプロンプトインジェクションパターン集

このドキュメントは sanitize.ts で検出対象とする既知パターンを記録・管理するためのものである。
新しいモデルや攻撃手法が公開された際にパターンを見直し、必要に応じて sanitize.ts の `LLM_MARKERS` を更新する。

本ファイルは **guarded-webfetch-claude / guarded-websearch-claude 両スキル共通の一次ソース**。`scripts/sanitize.ts` も同じく guarded-webfetch-claude 側で一元管理しており、guarded-websearch-claude は両者を re-export / 参照経由で共有する。**更新は必ず本ファイル側で行うこと**。

## 更新運用

### 更新トリガー

以下のいずれかが発生したらパターン見直しを検討する:

- 新しい LLM のチャットテンプレートマーカーが公開された（例: 新ベンダの `<|...|>` 形式）
- インジェクションパターンが公開・観測された（外部ブログ、CVE、Anthropic Trust Center 等）
- 運用中に false positive / false negative が観測された
- WebFetch / WebSearch ツールの返却形式変更でテキスト構造が変わった

### 更新手順

1. 本ファイル該当カテゴリの表にパターン行を追加（または修正）。「追加日」列には ISO 日付（例: `2026-04-29`）を記載
2. `.claude/skills/guarded-webfetch-claude/scripts/sanitize.ts` の `LLM_MARKERS` 配列に対応する正規表現エントリを追加
3. 同ファイルの `import.meta.vitest` ブロック内 `neutralizeMarkers` describe 群に、新パターンの置換と `suspicious_patterns` 計上を検証するテストケースを追加
4. `vp test .claude/skills/guarded-webfetch-claude/scripts/sanitize.ts --run` で in-source テストが通ることを確認
5. 本ファイル末尾の「更新履歴」に変更概要を 1 行追記

### 設計上の注意

- **カテゴリ名の安定性**: `chat_template` / `role_declaration` / `instruction_override` 等の既存カテゴリ名は main agent が判定に使う。新カテゴリを増やすのは可だが、既存カテゴリ名は変更しない（リネームは要設計レビュー）
- **過検出寄り fail-closed の方針**: false positive で「要確認」判定になっても、ユーザー確認で運用補完する設計。検出範囲を狭めるリファクタは設計判断を伴うため design-plan.md セクション 10 の方針と照合する
- **新カテゴリ追加時の main agent 影響**: 出力 JSON の `aggregate_flags.suspicious_patterns` に新カテゴリのキーが現れるが、main agent の判定ロジックは「カテゴリ別件数の存否のみ」に依存しているため、SKILL.md 側の更新は通常不要

## チャットテンプレート

| パターン                                                                 | 説明                                                  | 追加日     |
| ------------------------------------------------------------------------ | ----------------------------------------------------- | ---------- |
| `<\|[a-z0-9_]+\|>` (包括)                                                | ChatML / OpenAI Harmony 系の `<\|...\|>` sigil 全般   | 2026-04-29 |
| ↳ うち `<\|im_start\|>`, `<\|im_end\|>`, `<\|endoftext\|>`               | ChatML / GPT 系                                       | 初期       |
| ↳ うち `<\|start\|>`, `<\|end\|>`, `<\|message\|>`, `<\|channel\|>` ほか | OpenAI Harmony format（Codex/ChatGPT 系の特権ロール） | 2026-04-29 |
| `<s>`, `</s>`                                                            | LLM BOS/EOS トークン（Llama 等）                      | 初期       |
| `<system>`, `<assistant>`, `<user>`, `<untrusted_content>`               | ロールタグ擬装（開閉タグ両方）                        | 初期       |
| `<developer>`, `</developer>`                                            | OpenAI/Codex 系の特権ロールタグ                       | 2026-04-29 |
| `[INST]`, `[/INST]`                                                      | Llama 2 instruction テンプレート                      | 初期       |

## ロール宣言

| パターン                                 | 説明                            | 追加日     |
| ---------------------------------------- | ------------------------------- | ---------- |
| 行頭の `human:`, `assistant:`, `system:` | Claude / ChatGPT 風ロール宣言   | 初期       |
| 行頭の `developer:`                      | OpenAI/Codex 系の特権ロール宣言 | 2026-04-29 |

## 指示上書き

| パターン                                             | 説明                       | 追加日 |
| ---------------------------------------------------- | -------------------------- | ------ |
| `ignore (all) (previous\|prior\|above) instructions` | 指示無視パターン           | 初期   |
| `disregard (all) (previous\|prior\|above)`           | 指示無視パターン（別表現） | 初期   |
| `new instructions:`                                  | 新規指示注入               | 初期   |
| `you are now ...`                                    | ロール上書き               | 初期   |

## 更新履歴

- 初期: sanitize.ts の初期パターンを記録
- 2026-04-29: OpenAI Harmony format (`<|start|>` / `<|end|>` / `<|message|>` / `<|channel|>` 等) と `developer` 特権ロール（chat*template / role_declaration 両層）に対応。`<|...|>` 系は `<\|[a-z0-9*]+\|>` の包括パターンに統合した
