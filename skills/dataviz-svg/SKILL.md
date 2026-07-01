---
name: dataviz-svg
license: MIT
description: >
  Vega-Lite を使ったデータ可視化チャートの SVG/PNG 生成・Markdown 埋め込みスキル。
  Mermaid では表現できない統計チャート（散布図、ヒートマップ、ヒストグラム、箱ひげ図、面グラフ、複合チャート等）や、
  データ駆動の高度なグラフが必要な場面で使用する。
  ユーザーが「グラフを作って」「チャートを生成して」「データを可視化して」「Vega-Lite で」と言った場合、
  またはドキュメント作成中に Mermaid の円グラフ・ガントチャート以上の表現力が求められる場合はこのスキルを発動すること。
  単純なフローチャートやシーケンス図は Mermaid で十分なので対象外。
allowed-tools: Bash(bash .claude/skills/dataviz-svg/scripts/render-svg.sh:*)
---

# dataviz-svg

Vega-Lite の JSON spec から SVG と PNG を生成し、Markdown ドキュメントに埋め込む。
`vega-lite` / `vega` をバンドルしたスクリプト (`vl2svg.mjs`) と、PNG 変換用の `resvg.wasm` / Noto Sans JP フォントを同梱しており、追加インストール不要でブラウザなし・ヘッドレス環境でも動作する。

本スキルの独自コードは MIT ライセンスで提供する。同梱する third-party runtime asset のライセンスは `THIRD_PARTY_NOTICES.md` を参照する。

## 前提条件

- Node.js >= 18

## 実行フロー

### 1. データと可視化要件を把握する

ユーザーの要求から以下を確認する:

- 入力データ（インライン値、CSV/JSON ファイル、URL）
- チャートタイプ（棒、折れ線、散布図、ヒートマップ等）
- エンコーディング（x 軸、y 軸、色、サイズ等に何をマッピングするか）
- 出力先の Markdown ファイルパスと SVG の配置場所

### 2. Vega-Lite JSON spec を書く

Vega-Lite v5 の spec を JSON で作成する。よく使うパターンは `references/vegalite-patterns.md` を参照。

SVG 出力向けのポイント:

- `"width"` / `"height"` を明示する（SVG はブラウザのようなレスポンシブリサイズがないため）
- 日本語テキストを使う場合は `"config": {"font": "sans-serif"}` を設定する
- `"background": "transparent"` でドキュメントの背景に馴染ませる（暗色テーマ対応が不要な場合は `"white"` も可）
- `"autosize": {"type": "fit", "contains": "padding"}` でサイズ制御を安定させる
- 凡例やタイトルが切れないよう `"padding"` に余裕を持たせる

spec を JSON ファイルとして保存する。保存先は出力 SVG と同じディレクトリか、ドキュメントの `assets/` 配下が適切。

### 3. SVG と PNG をレンダリングする

Claude Code では:

```bash
bash .claude/skills/dataviz-svg/scripts/render-svg.sh <spec.json> <output.svg> [output.png]
```

Codex では:

```bash
bash .agents/skills/dataviz-svg/scripts/render-svg.sh <spec.json> <output.svg> [output.png]
```

`output.png` を省略した場合は、`output.svg` と同じベース名の PNG を生成する（例: `chart.svg` → `chart.png`）。

`allowed-tools` は Claude Code 向けの権限指定であり、Codex では本文の実行例に従ってレンダリングする。

スキルに同梱された `vl2svg.mjs`（vega-lite + vega のバンドル）、`resvg.wasm`、Noto Sans JP フォントを使用する。追加インストールは不要。

### 4. Markdown に埋め込む

生成された SVG または PNG をドキュメントに埋め込む:

```markdown
![チャートタイトル](./assets/chart.svg)
![チャートタイトル](./assets/chart.png)
```

サイズ指定が必要な場合は HTML タグを使う:

```html
<img src="./assets/chart.svg" alt="チャートタイトル" width="600" />
```

### 5. 確認と調整

生成された SVG を Read ツールで確認し、必要に応じて spec を修正して再レンダリングする。
よくある調整:

- 軸ラベルの回転（`"labelAngle": -45`）
- 色スケールの変更（`"scale": {"scheme": "category10"}`）
- フォントサイズの調整（`"config": {"axis": {"labelFontSize": 12}}`）

## Mermaid との使い分け

| 用途                                               | 推奨ツール                               |
| -------------------------------------------------- | ---------------------------------------- |
| フローチャート、シーケンス図、ER 図、状態遷移図    | Mermaid                                  |
| 棒グラフ、折れ線グラフ（データ数件の簡易表示）     | Mermaid pie / xychart                    |
| 散布図、ヒートマップ、ヒストグラム、箱ひげ図       | **Vega-Lite（本スキル）**                |
| 多系列・積み上げ・グループ化チャート               | **Vega-Lite（本スキル）**                |
| データ変換（集計、ビニング、フィルタ）を伴う可視化 | **Vega-Lite（本スキル）**                |
| インタラクティブ可視化（選択、ズーム）             | Vega-Lite（ただし SVG では静的出力のみ） |

## リファレンス

チャートタイプ別の spec パターンと SVG 向けベストプラクティスは `references/vegalite-patterns.md` にまとめている。
複雑なチャートを書く前や、使い慣れないマークタイプを使う場合に参照する。
