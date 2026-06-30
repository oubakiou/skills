# dataviz-svg 設計計画

このドキュメントは `dataviz-svg` skill の設計意図・構成・割り切りを記録するためのものである。skill の `references/design-plan.md` として配置し、将来の改修・移植・監査時の参照資料とする。

## 目次

1. [スキルの目的](#1-スキルの目的)
2. [トリガー条件](#2-トリガー条件)
3. [動作環境と制約](#3-動作環境と制約)
4. [ディレクトリ構成](#4-ディレクトリ構成)
5. [実行フロー](#5-実行フロー)
6. [SVG 生成の仕組み](#6-svg-生成の仕組み)
7. [Vega-Lite spec のベストプラクティス](#7-vega-lite-spec-のベストプラクティス)
8. [テストケース](#8-テストケース)
9. [設計上の割り切り](#9-設計上の割り切り)
10. [将来的な拡張候補](#10-将来的な拡張候補)
11. [参考資料](#11-参考資料)

## 1. スキルの目的

Markdown ドキュメント作成時に Mermaid では表現できないデータ駆動の可視化チャートを、Vega-Lite の JSON spec から SVG として生成し埋め込む。

### 背景: Mermaid の表現力の限界

Mermaid はフローチャート・シーケンス図・ER 図・ガントチャートなど構造図に強いが、データ可視化では以下の制約がある:

- **チャートタイプの制限**: 散布図、ヒートマップ、ヒストグラム、箱ひげ図、面グラフ、バブルチャートなどを描画できない
- **データ変換の欠如**: 集計（aggregate）、ビニング、フィルタリング、ピボット（fold）など、可視化前のデータ加工機能がない
- **エンコーディングの自由度**: 色・サイズ・形状・透明度へのデータマッピングができない（Mermaid の色指定は手動のスタイリングのみ）
- **複合ビュー**: レイヤリング（折れ線 + しきい値ルール）、ファセット（小さな多数グラフ）、連結（異なるチャートの並列表示）に対応していない
- **スケール制御**: 対数スケール、時間軸スケール、カスタム色スケールなどが使えない

Vega-Lite はこれらをすべてカバーする宣言的な可視化文法であり、JSON spec を書くだけで高品質なチャートを生成できる。`vl2svg` CLI により、ブラウザやランタイム環境に依存せず SVG を出力できるため、CI/CD パイプラインやヘッドレス環境でのドキュメント生成にも適している。

### アーキテクチャ概要

```
main agent
  ├─ Vega-Lite JSON spec を作成 → <spec>.json に保存
  │
  └─ Bash: render-svg.sh <spec>.json <output>.svg
       │
       │  ┌─────────────────────────────────┐
       │  │ render-svg.sh                    │
       │  │  bundled vl2svg.mjs              │
       │  │  <spec>.json → <output>.svg     │
       │  └──────────┬──────────────────────┘
       │             │ SVG ファイル
       ▼
  main agent: SVG を Markdown に埋め込み
       │
       └─ ![title](./assets/chart.svg)
```

本スキルはセキュリティ防御層ではなく、ドキュメント生成ワークフローを支援するユーティリティである。Vega-Lite spec の `data.url` にローカルファイルや URL を指定した場合は、レンダリング時にそのデータソースを読み込む。guarded 系スキルのような未信頼 Web コンテンツ取得を主目的とするものではないため、隔離アーキテクチャは持たない。

## 2. トリガー条件

以下のいずれかに該当するとき発火させる:

- ユーザーがデータ可視化・チャート・グラフの生成を要求し、Mermaid では表現が困難な内容である
- ユーザーが Vega-Lite を明示的に指定した
- 散布図、ヒートマップ、ヒストグラム、箱ひげ図、面グラフ、バブルチャートなど Mermaid 非対応のチャートタイプが求められた
- データ変換（集計、ビニング、フィルタ）を伴う可視化が必要
- 複数系列・積み上げ・グループ化など、Mermaid の xychart を超える表現が必要

以下の場合は **発火しない**:

- フローチャート、シーケンス図、ER 図、状態遷移図、ガントチャート → Mermaid で十分
- 数件のデータによる簡易な棒グラフ・円グラフ → Mermaid の pie / xychart で対応可能
- インタラクティブ性（ホバー、ズーム、フィルタ操作）が主要件 → SVG では静的出力のみのため、Vega-Lite の HTML embed や Observable 等を案内する

### Mermaid との境界判定

判断に迷う場合は以下を基準とする:

| 要件                                            | Mermaid | Vega-Lite   |
| ----------------------------------------------- | ------- | ----------- |
| データ点が 10 件以下の単純な棒/円               | ○       | △（過剰）   |
| データ点が 20 件以上                            | △       | ○           |
| 2 軸以上のエンコーディング（x, y, color, size） | ×       | ○           |
| データ変換（集計・ビニング・フィルタ）が必要    | ×       | ○           |
| 時系列データの折れ線（多系列）                  | △       | ○           |
| 構造図（フロー・ER・シーケンス）                | ○       | ×（不向き） |

## 3. 動作環境と制約

- **実行環境は Node.js >= 18**: バンドル済みの `vl2svg.mjs` を `node` で実行するため。リポジトリの guarded 系スキルは Node.js 23.6+ を要求するが、本スキルは TypeScript の直接実行を行わないため 18 以上で動作する
- **外部パッケージのバンドル同梱**: `vega`（6.2.0）と `vega-lite`（6.4.3）を Vite（`vp build`）で単一の ESM ファイル `scripts/vl2svg.mjs`（約 1.6MB）にバンドルし、スキルに同梱する。追加の `npm install` は不要。guarded 系スキルの「依存ゼロ」方針とは異なり、チャートレンダリングという性質上外部パッケージへの依存は不可避だが、バンドルにより配布時点で自己完結する
- **実行速度**: バンドルからの直接実行で約 0.3-0.5 秒。初回ダウンロードの遅延なし
- **オフライン環境**: バンドルが同梱されているため、インストール後は完全にオフラインで動作する
- **canvas 非同梱**: `vega` はテキスト測定のために `canvas` パッケージ（node-canvas）をオプショナル依存として持つが、バンドルには含めていない。テキストのバウンディングボックス計算が近似値になり、ラベルの位置が微妙にずれる場合がある。SVG の基本的なレンダリングには影響しない
- **開発・再ビルド環境は Node.js >= 20**: `vega-lite` 6.x の package metadata が Node.js 20 以上を要求するため、`vl2svg.mjs` の再生成は Node.js 20 以上で行う
- **ビルド方法**: ソース `scripts/vl2svg.ts` を変更した場合、`skills/dataviz-svg/` ディレクトリで `vp build -c vite.build.ts` を実行して `scripts/vl2svg.mjs` を再生成する。ビルドにはルート `package.json` の devDependencies にある `vega` / `vega-lite` が必要。`vite.build.ts` は `import.meta.vitest` を `undefined` に置換し、in-source test を配布 bundle から除外する

## 4. ディレクトリ構成

```
dataviz-svg/
├── SKILL.md                          # スキル定義（トリガー条件・実行フロー）
├── vite.build.ts                     # バンドルビルド設定（開発用）
├── scripts/
│   ├── render-svg.sh                 # エントリポイント（node vl2svg.mjs のラッパー）
│   ├── vl2svg.ts                     # バンドルソース（開発用、vp build の入力）
│   └── vl2svg.mjs                    # 📦 vega + vega-lite バンドル（vp build で生成、約 1.6MB）
└── references/
    ├── design-plan.md                # このドキュメント
    └── vegalite-patterns.md          # チャートパターン集・SVG ベストプラクティス
```

guarded 系スキルと異なり、隔離プロセスやサニタイザは不要。構成はシンプルに保つ。

## 5. 実行フロー

### ステップ 1: データと可視化要件の把握

ユーザーの要求から以下を確認する:

- **入力データ**: インライン値（spec の `data.values` に直接記述）、外部ファイル（CSV / JSON / TSV）、または URL
- **チャートタイプ**: 棒・折れ線・散布図・面・ヒートマップ・ヒストグラム・箱ひげ図・円/ドーナツ・複合
- **エンコーディング**: x 軸、y 軸、色、サイズ、形状、テキストラベル等に何のフィールドをマッピングするか
- **データ変換**: 集計、フィルタ、ビニング、fold（ワイド→ロング変換）等が必要か
- **出力先**: Markdown ファイルのパスと、SVG の配置ディレクトリ

データが明示されていない場合は、ユーザーにデータの提供を求めるか、サンプルデータで仮のチャートを生成してから調整する。

### ステップ 2: Vega-Lite JSON spec の作成

`references/vegalite-patterns.md` のパターンを参考に spec を作成する。SVG 出力向けの推奨設定（`width`/`height` 明示、`background`、`autosize`、`font` 設定）を含める。

spec は JSON ファイルとして保存する。配置先の規約:

- ドキュメントと同階層の `assets/` ディレクトリ（推奨）
- ドキュメントと同じディレクトリ
- ユーザーが明示的に指定した場所

ファイル名はチャートの内容を反映させる（例: `sales-trend.vl.json`、`access-heatmap.vl.json`）。`.vl.json` 拡張子は Vega-Lite spec であることを明示するための慣例。

### ステップ 3: SVG レンダリング

```bash
bash .claude/skills/dataviz-svg/scripts/render-svg.sh <spec.json> <output.svg>
```

スクリプトの動作:

1. 引数を検証（spec ファイルの存在確認、出力ディレクトリの自動作成）
2. スキル同梱の `scripts/vl2svg.mjs` を `node` で実行
3. `vl2svg.mjs` が Vega-Lite spec を Vega spec にコンパイルし、Vega runtime で SVG を生成
4. 正常終了時は `SVG generated: <output.svg>` を stdout に出力

### ステップ 4: Markdown への埋め込み

生成された SVG を対象の Markdown ファイルに埋め込む:

```markdown
![チャートタイトル](./assets/chart.svg)
```

サイズ制御が必要な場合は HTML タグを使う:

```html
<img src="./assets/chart.svg" alt="チャートタイトル" width="600" />
```

### ステップ 5: 確認と調整

生成された SVG を Read ツールで確認し、必要に応じて spec を修正して再レンダリングする。典型的な調整項目:

- 軸ラベルの角度・フォントサイズ
- 色スケール・配色スキーム
- padding / width / height
- タイトル・凡例の位置

## 6. SVG 生成の仕組み

### vl2svg.mjs wrapper

`vl2svg.mjs` は `vega-lite` と `vega` を単一ファイルにバンドルした自前 wrapper である。Vega-Lite の JSON spec を読み込み、`vega-lite` の `compile()` で Vega spec に変換した後、Node.js 上の Vega runtime で SVG にレンダリングする。

```
Vega-Lite JSON spec
    ↓ (vega-lite compiler)
Vega JSON spec
    ↓ (vega runtime + scenegraph)
SVG 文字列
    ↓
ファイル出力
```

### render-svg.sh の設計

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: render-svg.sh <spec.json> <output.svg>" >&2
  exit 1
fi

SPEC_FILE="$1"
OUTPUT_FILE="$2"

if [[ ! -f "$SPEC_FILE" ]]; then
  echo "Error: spec file not found: $SPEC_FILE" >&2
  exit 1
fi

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
node "$SKILL_DIR/scripts/vl2svg.mjs" "$SPEC_FILE" "$OUTPUT_FILE"
```

設計判断:

- **バンドル同梱**: `vl2svg.mjs` は `vega` + `vega-lite` を Vite でバンドルした単一 ESM ファイル（約 1.6MB）。79MB の `node_modules` を 1/50 に圧縮しつつ、追加インストール不要で即時実行できる
- **出力ディレクトリの自動作成**: `vl2svg.mjs` 内で `mkdirSync(outDir, { recursive: true })` を実行。ユーザーが `assets/` を事前に作る手間を省く
- **エラーハンドリング**: `set -euo pipefail` によりコマンド失敗時は即座に非ゼロ exit code で終了。main agent はエラー出力からユーザーに原因を伝える
- **ベースディレクトリ**: `vl2svg.mjs` は spec ファイルのディレクトリを自動的にベースディレクトリとして使用する。相対・絶対・`file://` のローカルデータファイルは Node.js の `fs` で読み込み、HTTP(S) / data URL は Vega の loader に委譲する

### 外部データファイルの参照

`vl2svg.mjs` は spec ファイルのディレクトリを自動的にベースディレクトリとして設定するため、spec 内の `data.url` で相対パスを使える:

```json
{ "data": { "url": "data/sales.csv", "format": { "type": "csv" } } }
```

spec ファイルが `/docs/assets/chart.vl.json` にある場合、上記は `/docs/assets/data/sales.csv` として解決される。データをインライン（`data.values`）に含めることを推奨するが、大規模データや複数チャートでのデータ共有時には外部ファイル参照が有用。

## 7. Vega-Lite spec のベストプラクティス

SVG 出力に特化したベストプラクティス。詳細なパターン集は `references/vegalite-patterns.md` を参照。

### サイジング

SVG にはブラウザのようなレスポンシブリサイズがないため、`width` と `height` の明示が必須。用途別の推奨サイズ:

| 用途                           | 推奨サイズ (px)                |
| ------------------------------ | ------------------------------ |
| ドキュメント全幅               | 600-800 × 350-450              |
| 並列配置（2列）                | 350-400 × 250-300              |
| 小さなスパークライン           | 200 × 80                       |
| ファセット（小さな多数グラフ） | 各サブビュー 150-200 × 120-150 |

### フォント

SVG にフォントは埋め込まれない。レンダリング環境のシステムフォントに依存する。`"config": {"font": "sans-serif"}` で汎用フォントファミリーを指定するのが最も安全。

日本語テキストを含む場合:

- `sans-serif` はほとんどの環境でゴシック体系のフォント（Noto Sans CJK、ヒラギノ角ゴ等）にフォールバックする
- 特定フォントを指定すると、そのフォントがない環境では文字化けや位置ずれが発生する
- `canvas` パッケージ（node-canvas）がインストールされていない場合、日本語文字のバウンディングボックス計算が不正確になり、ラベル間の重なりが発生する場合がある

### 背景色

- `"transparent"`: ドキュメントの背景色に自然に馴染む。ライトテーマ・ダークテーマ両対応だが、チャートの線色や軸ラベルがダークテーマで見えにくくなる可能性がある
- `"white"`: 印刷やPDF エクスポートに安全。ダークテーマでは浮くが、チャートの視認性は常に保証される

### 色スケール

`references/vegalite-patterns.md` の「色スケール」セクションを参照。色覚バリアフリーを考慮する場合は `viridis`（連続値）または `tableau10`（カテゴリ）を推奨。

## 8. テストケース

1. **基本棒グラフ**: インラインデータの単純な縦棒グラフ → spec 作成 → SVG 生成 → Markdown 埋め込み。正しい SVG が生成され、Markdown の画像リンクが有効
2. **散布図 + 回帰線**: 2 変数の相関を示す散布図に `layer` で回帰線（`"mark": "line"` + `"transform": [{"regression": ...}]`）を重ねる → 複合チャートが単一 SVG に正しくレンダリングされる
3. **積み上げ面グラフ**: 時系列 × 多系列の積み上げ面グラフ → `"type": "temporal"` の軸が正しくフォーマットされ、積み上げの順序が一貫している
4. **ヒートマップ**: 2 次元カテゴリ × 数値の矩形グリッド → `"mark": "rect"` + 色スケールが正しく適用され、セル境界が明瞭
5. **日本語ラベル**: 軸ラベル・タイトル・凡例に日本語を含むチャート → 文字化けなく SVG に含まれ、`sans-serif` フォント指定が反映されている
6. **外部データ参照**: spec の `data.url` で CSV ファイルを参照 → spec ファイルのディレクトリをベースに相対パスが解決され、チャートが生成される
7. **大規模データ**: 1000 行以上のデータによるチャート → SVG のファイルサイズが妥当（数百 KB 以下）で、レンダリングが完了する
8. **ファセット**: `facet` による小さな多数グラフ → 各サブビューのサイズが個別設定され、全体のレイアウトが崩れない
9. **不正な spec**: JSON 構文エラーまたは Vega-Lite の validation エラーを含む spec → `vl2svg.mjs` がエラーメッセージを stderr に出力し、非ゼロ exit code で終了。main agent がユーザーにエラー内容を伝える
10. **出力ディレクトリ不在**: 存在しない出力パス（例: `assets/charts/output.svg`）を指定 → `vl2svg.mjs` が `mkdirSync` でディレクトリを自動作成し、SVG を生成

基本的なレンダリング挙動は `scripts/vl2svg.ts` の in-source test で自動検証する。対象はインラインデータ、相対 CSV、存在しない spec、出力ディレクトリ自動作成。複雑なチャートの見た目や Markdown 埋め込み確認は手動で検証する。

## 9. 設計上の割り切り

- **SVG のみ、PNG/PDF は非対応**: `vl2svg` による SVG 出力に特化する。PNG（`vl2png`）や PDF は追加の依存（`canvas` / `sharp` / `puppeteer` 等）が必要であり、スキルの複雑さが増す。SVG は Markdown での埋め込みに最も適しており、必要に応じてユーザーが外部ツールで変換できる
- **フォント埋め込みなし**: SVG にフォントを埋め込む機能は提供しない。`@font-face` の SVG 内記述や Base64 エンコードは可能だが、ファイルサイズが肥大化し可搬性も下がるため、システムフォントへのフォールバックを推奨する
- **インタラクティブ性なし**: SVG 出力は静的画像であり、Vega-Lite のインタラクティブ機能（selection、params、条件付きエンコーディング）は反映されない。ホバーツールチップ・ズーム・フィルタが主要件の場合は HTML embed を案内する
- **canvas 非同梱**: バンドルに `node-canvas` を含めていないため、テキスト測定が近似値になる。大半のチャートでは問題にならないが、長い日本語ラベルの位置計算で微妙なずれが発生する可能性がある
- **バンドルの Vega-Lite バージョン固定**: バンドルに含まれる `vega-lite`（6.4.3）と `vega`（6.2.0）は `vp build` 時のバージョンで固定される。更新するにはソース `vl2svg.ts` の依存を更新して再ビルドが必要
- **バンドルサイズ**: `vl2svg.mjs` は約 1.6MB。git 管理下に置くため、頻繁なバージョン更新はリポジトリサイズに影響する
- **バンドルは formatter / linter 対象外**: `vl2svg.mjs` は `vite.config.ts` の `ignorePatterns` で `vp check` の対象から外す。品質確認は `vl2svg.ts` の lint / type check、`vp build -c vite.build.ts` による再生成、レンダリング smoke test で行う
- **大規模データの SVG サイズ**: データ点が多い（数千点以上の散布図等）場合、SVG のファイルサイズが数 MB になる。Markdown ドキュメントに大きな SVG を複数埋め込むとレンダリング性能が低下する。大規模データの場合はビニング・サンプリング等のデータ削減を推奨する
- **LLM の Vega-Lite 知識に依存**: spec の作成は main agent の Vega-Lite に関する学習済み知識に依存する。`references/vegalite-patterns.md` で主要パターンを提供するが、マイナーな機能や最新の追加仕様はカバーしきれない
- **セキュリティ考慮は最小限**: 本スキルはユーザーが提供する spec とデータを可視化する。`data.url` に外部 URL を指定した場合、`vl2svg` はその URL にアクセスするが、これはユーザーの明示的な指定に基づく操作であり、本スキルの守備範囲外とする

## 10. 将来的な拡張候補

- **PNG 出力サポート**: `vl2png` の追加。`canvas` パッケージが必要だが、Markdown プレビューアが SVG を正しくレンダリングしない環境（一部の Markdown エディタ、メール等）向けに有用
- **テーマシステム**: 組織のブランドカラーやドキュメントのデザインシステムに合わせたカスタムテーマ（`config` オブジェクト）を `references/` にバンドル。ユーザーがテーマ名を指定するだけで統一された見た目のチャートを生成できる
- **spec バリデーション**: `render-svg.sh` 実行前に spec を Vega-Lite の JSON Schema でバリデーションし、わかりやすいエラーメッセージを提供する。現状は `vl2svg` のエラー出力をそのまま返しているが、初心者には不親切な場合がある
- **複数チャートの一括生成**: ドキュメント内の全チャートを一括で再生成するバッチモード。spec ファイルの命名規約に基づき、対応する SVG を自動更新する
- **HTML インタラクティブ出力**: SVG の代わりに Vega-Embed を含む HTML を生成し、インタラクティブなチャートをドキュメントに埋め込む。静的 Markdown では動作しないが、ブラウザで表示するドキュメント向けには有用
- **データ前処理スクリプト**: CSV / JSON の前処理（列選択、型変換、欠損値処理）を行うスクリプトを `scripts/` にバンドルし、Vega-Lite の `transform` では対応しきれない複雑な加工をサポートする
- **アクセシビリティ強化**: 生成 SVG に ARIA 属性や `<title>` / `<desc>` 要素を追加するポストプロセス。Vega が出力する SVG は基本的な ARIA 属性（`role="graphics-object"` 等）を含むが、チャート全体の説明テキストはユーザーが手動で追加する必要がある

## 11. 参考資料

- Vega-Lite 公式ドキュメント -- https://vega.github.io/vega-lite/docs/
- Vega-Lite Examples Gallery -- https://vega.github.io/vega-lite/examples/
- Vega CLI (vl2svg / vl2png) -- https://github.com/vega/vega/tree/main/packages/vega-cli
- Vega-Lite JSON Schema -- https://vega.github.io/schema/vega-lite/v5.json
- SVG 仕様 (W3C) -- https://www.w3.org/TR/SVG2/
- Markdown での画像埋め込み (CommonMark) -- https://spec.commonmark.org/0.31.2/#images
