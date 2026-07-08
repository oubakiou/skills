# gdscript-quality skill — ベンチマーク結果（iteration-1）

skill あり/なしの A/B 比較。2026-07-07 実施。

## 計測方法

- **ハーネス**: Claude Code の subagent（skill-creator の評価ループ）。skill あり run には SKILL.md の読解を指示、なし run は同一プロンプトのみ。両アームとも同一フィクスチャ・同一環境（Godot 4.4.1 headless）。
- **モデル**: claude-sonnet-5 / claude-opus-4-8（各 3 eval × with/without = 6 run、計 12 run）
- **eval**: 型品質を一切要求しないプロンプトで、skill が自発的に効くかを見る
  1. `new-inventory-system` — 新規プロジェクトでインベントリ実装 + 自作テスト
  2. `refactor-legacy-wave-manager` — 「動くが雑」なレガシーコード（無型・dict-as-struct・マジックナンバー、strict 警告 18 件）を挙動固定テスト維持でリファクタ
  3. `add-health-system-feature` — クリーンな既存プロジェクトにシグナル駆動の体力システムを追加
- **assertion（各 eval 4 件）**: 挙動（テスト通過 / headless 起動）、strict 警告ゲート（`scripts/check.sh`: untyped/unsafe 5 種を error 昇格して全 .gd を検査）、dict-as-struct 排除・定数化・シグナル型付けなどの品質判定

## 結果サマリ

|                     |   sonnet |    sonnet+skill |     opus |      opus+skill |
| ------------------- | -------: | --------------: | -------: | --------------: |
| assertion pass rate |      75% |        **100%** |    66.7% |        **100%** |
| 平均トークン        |   43,113 |   63,870 (+48%) |   32,646 |   47,791 (+47%) |
| 平均時間            | 200.0 秒 | 331.3 秒 (+66%) | 191.5 秒 | 259.6 秒 (+36%) |

### eval 別内訳（passed/4）

| eval               | sonnet | sonnet+skill | opus | opus+skill |
| ------------------ | -----: | -----------: | ---: | ---------: |
| 新規実装           |    4/4 |          4/4 |  2/4 |        4/4 |
| レガシーリファクタ |    2/4 |          4/4 |  2/4 |        4/4 |
| 機能追加           |    3/4 |          4/4 |  4/4 |        4/4 |

## 主な発見

1. **タスクの成否は変わらず、品質だけが変わる。** 12 run すべてでテスト通過・起動に成功。skill が変えるのは「どう書かれたか」と「検証されたか」。
2. **「強いモデルなら skill 不要」ではない。** opus baseline は sonnet baseline より品質 assertion の成績が悪い（インベントリのスロットを `Array[Dictionary]` + 全読み取り `int()` キャストで実装＝unsafe 6 件、リファクタ課題では Dictionary 構造・文字列種別を全面維持）。一方 opus baseline は機能追加 eval では自作テストヘルパーまで型付けして満点。**素のモデルはタスクごとに得意分野がばらつくが、skill は両モデルを全 eval 100% に平準化する**。skill の実効価値は上振れの伸長ではなく品質の床の保証。
3. **baseline の失点はすべて「Variant 漏れ」系。** 無型 Dictionary / 無型 Node 経由のアクセスが unsafe 警告になるパターンで、skill が狙った失敗モードと一致。`-> void` 等の基本注釈は両モデルとも素で書けており、失点源にならなかった。
4. **skill のオーバーヘッドはモデル性能と複合しない。** トークン増分は両モデルとも +47〜48%（skill 読解 + check.sh 修正ループの固定費）。
5. **エンジン挙動の発見**: GDScript 警告は設定値 1（warn）では headless 実行で一切出力されず、2（error 昇格）で初めて `SCRIPT ERROR: ... (Warning treated as error.)` として stderr に出る。headless CI で型警告を数える場合は必ず 2 に昇格すること（check.sh はこれを一時注入で行う）。

## 既知の限界と計測後の修正

- **n=1/セル**: eval 単位の結論は方向性の参考。反復を増やすまで断定しない
- **greenfield eval は sonnet では弁別しない**（両アーム 4/4）。opus では弁別した（baseline 2/4）ため当面維持
- 計測で見つかった問題は計測後に修正済み（上記の数値は修正前の状態で取得したもの）:
  - フィクスチャ債務: レガシーリファクタ用 `tests/run_tests.gd` 自体の UNSAFE_CALL_ARGUMENT 2 件（`_check(bool, ...)` への Variant 直渡し）→ typed local への narrowing で解消。dirty フィクスチャの findings は 18→16（全て対象ファイル由来）、型付きリファクタ後は完全 CLEAN になることを検証済み
  - references/typing.md: nullable return 契約（`-> Dictionary` 等の値型は `return null` 不可、`-> Variant` + `##` で契約を明示）を追記
  - SKILL.md: スコープ外ファイルに findings が残る場合の判定・報告ガイダンス（保護ファイルを黙って直さない / CLEAN と偽らない / pre-existing 主張は原本と突き合わせて検証）を追記

## トリガー（自動発動）の検証

skill-creator の description 最適化ループ（`run_loop.py`）は本 skill に対して recall 0% を返したが、これは計測系のアーティファクトだった。probe の `claude -p` が (a) 権限モードなしで起動されるためモデルが tool を一切使わずテキスト回答して終わる、(b) 最初の tool 呼び出しが対象 skill の Skill/Read でない時点で不発動と即断する（コーディング系タスクではモデルはまず対象コードを読むのが自然）、の 2 点による。

現実条件を模した手動 probe（Godot プロジェクトの sandbox、`--permission-mode acceptEdits`、claude-sonnet-5、「player.gd のバグを直して」という型に言及しないクエリ）では、モデルは find → player.gd Read → **3 手目で本 skill を発動** → 修正、という順で自然にトリガーした。description は現状のままで実用上機能すると判断し、最適化ループによる書き換えは見送った。

## 生データ

- sonnet: `gdscript-quality-workspace/iteration-1/`（`benchmark.json` / `benchmark.md` / `review.html`、各 run の `grading.json` / `timing.json` / `outputs/`）
- opus: `gdscript-quality-workspace/iteration-1-opus/`（同構成）
