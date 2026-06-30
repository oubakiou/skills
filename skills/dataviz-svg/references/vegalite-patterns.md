# Vega-Lite チャートパターン集

よく使うチャートタイプの spec パターンと、SVG 出力向けのベストプラクティス。
すべての例は Vega-Lite v5 の `$schema` を使用する。

## 目次

1. [共通テンプレート](#共通テンプレート)
2. [棒グラフ](#棒グラフ)
3. [折れ線グラフ](#折れ線グラフ)
4. [散布図](#散布図)
5. [面グラフ](#面グラフ)
6. [ヒートマップ](#ヒートマップ)
7. [ヒストグラム](#ヒストグラム)
8. [箱ひげ図](#箱ひげ図)
9. [円グラフ・ドーナツ](#円グラフドーナツ)
10. [複合チャート（layer）](#複合チャートlayer)
11. [ファセット・連結](#ファセット連結)
12. [データ変換](#データ変換)
13. [SVG 出力ベストプラクティス](#svg-出力ベストプラクティス)

---

## 共通テンプレート

すべての spec のベースとなる構造。SVG 出力用の推奨設定を含む。

```json
{
  "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
  "width": 500,
  "height": 300,
  "background": "transparent",
  "padding": 20,
  "autosize": { "type": "fit", "contains": "padding" },
  "config": {
    "font": "sans-serif",
    "axis": { "labelFontSize": 11, "titleFontSize": 13 },
    "legend": { "labelFontSize": 11, "titleFontSize": 12 },
    "title": { "fontSize": 15 }
  },
  "data": { "values": [] },
  "mark": "bar",
  "encoding": {}
}
```

---

## 棒グラフ

### 縦棒（基本）

```json
{
  "mark": "bar",
  "encoding": {
    "x": { "field": "category", "type": "nominal", "axis": { "labelAngle": 0 } },
    "y": { "field": "value", "type": "quantitative" },
    "color": { "field": "category", "type": "nominal", "legend": null }
  }
}
```

### 横棒

```json
{
  "mark": "bar",
  "encoding": {
    "y": { "field": "category", "type": "nominal", "sort": "-x" },
    "x": { "field": "value", "type": "quantitative" }
  }
}
```

### グループ化棒グラフ

```json
{
  "mark": "bar",
  "encoding": {
    "x": { "field": "category", "type": "nominal" },
    "y": { "field": "value", "type": "quantitative" },
    "color": { "field": "group", "type": "nominal" },
    "xOffset": { "field": "group", "type": "nominal" }
  }
}
```

### 積み上げ棒グラフ

```json
{
  "mark": "bar",
  "encoding": {
    "x": { "field": "date", "type": "temporal" },
    "y": { "field": "value", "type": "quantitative", "stack": "zero" },
    "color": { "field": "series", "type": "nominal" }
  }
}
```

100% 積み上げにするには `"stack": "normalize"` を使う。
月名や曜日のような順序付きカテゴリを `ordinal` で扱う場合は、`"sort": ["Jan", "Feb", ...]` のように明示的に並び順を指定する。

---

## 折れ線グラフ

### 単系列

```json
{
  "mark": { "type": "line", "point": true },
  "encoding": {
    "x": { "field": "date", "type": "temporal" },
    "y": { "field": "value", "type": "quantitative" }
  }
}
```

### 多系列

```json
{
  "mark": "line",
  "encoding": {
    "x": { "field": "date", "type": "temporal" },
    "y": { "field": "value", "type": "quantitative" },
    "color": { "field": "series", "type": "nominal" },
    "strokeDash": { "field": "series", "type": "nominal" }
  }
}
```

`strokeDash` を併用すると白黒印刷でも系列を区別できる。

---

## 散布図

### 基本

```json
{
  "mark": "point",
  "encoding": {
    "x": { "field": "x", "type": "quantitative" },
    "y": { "field": "y", "type": "quantitative" }
  }
}
```

### バブルチャート（サイズ + 色エンコーディング）

```json
{
  "mark": { "type": "point", "filled": true, "opacity": 0.7 },
  "encoding": {
    "x": { "field": "gdp", "type": "quantitative", "scale": { "type": "log" } },
    "y": { "field": "life_expectancy", "type": "quantitative" },
    "size": { "field": "population", "type": "quantitative" },
    "color": { "field": "region", "type": "nominal" },
    "tooltip": [
      { "field": "country", "type": "nominal" },
      { "field": "gdp", "type": "quantitative" },
      { "field": "life_expectancy", "type": "quantitative" }
    ]
  }
}
```

---

## 面グラフ

### 積み上げ面グラフ

```json
{
  "mark": "area",
  "encoding": {
    "x": { "field": "date", "type": "temporal" },
    "y": { "field": "value", "type": "quantitative", "stack": "zero" },
    "color": { "field": "series", "type": "nominal" }
  }
}
```

### ストリームグラフ

`"stack": "center"` で中央揃え。

---

## ヒートマップ

```json
{
  "mark": "rect",
  "encoding": {
    "x": { "field": "hour", "type": "ordinal" },
    "y": { "field": "day", "type": "ordinal" },
    "color": {
      "field": "count",
      "type": "quantitative",
      "scale": { "scheme": "blues" }
    }
  }
}
```

セル内にテキストを表示するには `layer` で `"mark": "text"` を重ねる。

---

## ヒストグラム

```json
{
  "mark": "bar",
  "encoding": {
    "x": { "field": "value", "type": "quantitative", "bin": true },
    "y": { "aggregate": "count", "type": "quantitative" }
  }
}
```

ビン幅の調整: `"bin": { "maxbins": 20 }` または `"bin": { "step": 10 }`。

---

## 箱ひげ図

```json
{
  "mark": { "type": "boxplot", "extent": 1.5 },
  "encoding": {
    "x": { "field": "category", "type": "nominal" },
    "y": { "field": "value", "type": "quantitative" },
    "color": { "field": "category", "type": "nominal", "legend": null }
  }
}
```

---

## 円グラフ・ドーナツ

### 円グラフ

```json
{
  "mark": { "type": "arc", "tooltip": true },
  "encoding": {
    "theta": { "field": "value", "type": "quantitative", "stack": true },
    "color": { "field": "category", "type": "nominal" }
  }
}
```

### ドーナツ

```json
{
  "mark": { "type": "arc", "innerRadius": 60, "tooltip": true },
  "encoding": {
    "theta": { "field": "value", "type": "quantitative", "stack": true },
    "color": { "field": "category", "type": "nominal" }
  }
}
```

---

## 複合チャート（layer）

折れ線 + ポイント + テキストラベルの重ね合わせ:

```json
{
  "layer": [
    {
      "mark": "line",
      "encoding": {
        "x": { "field": "date", "type": "temporal" },
        "y": { "field": "value", "type": "quantitative" }
      }
    },
    {
      "mark": { "type": "point", "filled": true, "size": 60 },
      "encoding": {
        "x": { "field": "date", "type": "temporal" },
        "y": { "field": "value", "type": "quantitative" }
      }
    },
    {
      "mark": { "type": "text", "dy": -12 },
      "encoding": {
        "x": { "field": "date", "type": "temporal" },
        "y": { "field": "value", "type": "quantitative" },
        "text": { "field": "value", "type": "quantitative", "format": ".0f" }
      }
    }
  ]
}
```

折れ線 + しきい値ルール:

```json
{
  "layer": [
    {
      "mark": "line",
      "encoding": {
        "x": { "field": "date", "type": "temporal" },
        "y": { "field": "value", "type": "quantitative" }
      }
    },
    {
      "mark": { "type": "rule", "color": "red", "strokeDash": [4, 4] },
      "encoding": {
        "y": { "datum": 80 }
      }
    }
  ]
}
```

---

## ファセット・連結

### ファセット（小さな多数グラフ）

```json
{
  "facet": { "field": "region", "type": "nominal", "columns": 3 },
  "spec": {
    "width": 150,
    "height": 120,
    "mark": "line",
    "encoding": {
      "x": { "field": "date", "type": "temporal" },
      "y": { "field": "value", "type": "quantitative" }
    }
  }
}
```

### 水平連結

```json
{
  "hconcat": [
    { "mark": "bar", "encoding": { "...": "..." } },
    { "mark": "point", "encoding": { "...": "..." } }
  ]
}
```

`vconcat` で垂直連結も可能。

---

## データ変換

### インラインデータ

```json
{
  "data": {
    "values": [
      { "category": "A", "value": 30 },
      { "category": "B", "value": 55 }
    ]
  }
}
```

### ファイル参照

```json
{
  "data": { "url": "data.csv", "format": { "type": "csv" } }
}
```

`render-svg.sh` は spec ファイルのディレクトリをベースディレクトリとして解決する。

### transform の主要操作

```json
{
  "transform": [
    { "filter": "datum.value > 10" },
    { "calculate": "datum.price * datum.quantity", "as": "total" },
    {
      "aggregate": [{ "op": "mean", "field": "score", "as": "avg_score" }],
      "groupby": ["category"]
    },
    { "fold": ["series_a", "series_b"], "as": ["series", "value"] },
    { "bin": true, "field": "age", "as": "age_bin" },
    {
      "window": [{ "op": "rank", "as": "rank" }],
      "sort": [{ "field": "score", "order": "descending" }]
    }
  ]
}
```

- **filter**: 行のフィルタリング
- **calculate**: 新しいフィールドの計算
- **aggregate**: グループ集計（sum, mean, count, min, max 等）
- **fold**: ワイド形式からロング形式への変換（複数列を 1 系列に）
- **bin**: 数値のビニング
- **window**: ウィンドウ関数（rank, lag, lead, running total 等）

---

## SVG 出力ベストプラクティス

### サイジング

SVG にはブラウザのような自動リサイズがない。`width` / `height` を明示する。

| 用途                 | 推奨サイズ        |
| -------------------- | ----------------- |
| ドキュメント全幅     | 600-800 x 350-450 |
| 並列配置（2列）      | 350-400 x 250-300 |
| 小さなスパークライン | 200 x 80          |

### フォント

SVG にフォントは埋め込まれない。`"config": {"font": "sans-serif"}` でシステムフォントにフォールバックさせるのが最も安全。

### 背景

- `"transparent"`: ドキュメントの背景色に馴染む（推奨）
- `"white"`: 暗色背景で浮くが、印刷やエクスポートに安全

### 色スケール

よく使う配色スキーム:

| スキーム                    | 用途                             |
| --------------------------- | -------------------------------- |
| `category10`                | カテゴリ（10色、デフォルト）     |
| `tableau10`                 | カテゴリ（色覚バリアフリー寄り） |
| `blues` / `reds` / `greens` | 単色の連続値                     |
| `viridis`                   | 連続値（色覚バリアフリー）       |
| `redblue`                   | ダイバージング（正負の対比）     |

### よくある落とし穴

- **日本語の軸ラベルが切れる**: `"padding"` を増やすか `"labelAngle"` で回転させる
- **凡例がチャート外にはみ出る**: `"padding": {"right": 120}` で右余白を確保
- **`autosize` が効かない**: `facet` / `concat` では `autosize` が無視される。各サブビューの `width` / `height` を個別に設定する
- **データ型の不一致**: 日付文字列は `"type": "temporal"` + `"timeUnit"` で明示的にパースする
- **月名・曜日などの `ordinal` 軸が意図しない順序になる**: `"sort": ["Jan", "Feb", ...]` のように明示する。日付として扱える値なら `"type": "temporal"` を使う
- **`stack` のデフォルト**: `bar` と `area` はデフォルトで積み上げ。単独表示なら `"stack": null` を明示する
