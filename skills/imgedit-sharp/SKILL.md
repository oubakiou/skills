---
name: imgedit-sharp
license: MIT
description: >
  既存の画像ファイル（写真・スクリーンショット・バナー・アイコン等）を編集・変換する作業全般で使用する。
  対象操作: リサイズ／サムネイル化（幅や px 指定、「縮小」「小さくする」も含む）、切り抜き（crop）、
  回転・反転、フォーマット変換（PNG/JPEG/WebP/AVIF/GIF/TIFF 間、例: tiff→png、png→jpg）、
  圧縮・軽量化（ファイルサイズを落とす、重い画像を小さくする）、ロゴ/透かしの合成、色調・明るさ調整、
  そしてスクリーンショットへの注釈（赤枠・矢印・ハイライトで特定領域を囲む、バグ報告用画像の作成）。
  ユーザーが具体的な画像ファイルパスや「この画像」「このスクリーンショット」を指しつつ、上記のような変更を求めたら
  （日本語・英語問わず、"resize" "crop" "rotate" "compress" "shrink" "convert to webp/png/jpg" のような表現でも）発動する。
  画像の新規生成（イラスト・写真風ビジュアルをゼロから作る）は対象外で delegate-imagegen を使う。
  チャート/グラフを SVG から新規生成してラスタライズする場合は dataviz-svg を使う。
allowed-tools: Bash(bash .claude/skills/imgedit-sharp/scripts/edit-image.sh:*)
---

# imgedit-sharp

既存画像の加工・編集を JSON spec で宣言し、同梱の sharp（libvips の WebAssembly ビルド）で実行する。
`scripts/vendor/` に sharp の wasm32 ビルドを同梱しており、追加インストール不要・オフラインで動作する。native binary を含まないため platform 非依存。

本スキルの独自コードは MIT ライセンスで提供する。同梱する third-party runtime asset のライセンスは `THIRD_PARTY_NOTICES.md` を参照する。

## 前提条件

- Node.js >= 23.6（TypeScript を追加ツールなしで直接実行するため）

## 実行フロー

### 1. 加工要件を把握する

ユーザーの要求から以下を確認する:

- 入力画像のパスとフォーマット（不明なら `--info` で確認する）
- 必要な操作（resize / crop / rotate / 合成 / 色調 / フォーマット変換）と順序
- 出力パスと出力フォーマット（拡張子から自動判定される）

入力画像の実寸が必要な場合（crop 座標の決定等）は先にメタデータを取得する:

```bash
bash .claude/skills/imgedit-sharp/scripts/edit-image.sh --info <image>
```

### 2. 編集 spec (JSON) を書く

操作パイプラインを JSON で記述し、ファイルとして保存する（一時的な spec は `.temp/` 配下に置く）:

```json
{
  "input": "screenshot.png",
  "output": "assets/hero.webp",
  "ops": [
    { "type": "crop", "left": 0, "top": 80, "width": 1200, "height": 630 },
    { "type": "resize", "width": 800 },
    { "type": "format", "format": "webp", "quality": 80 }
  ]
}
```

- `input` / `output` のパスは **実行時の cwd 基準**で解決される（絶対パスも可）
- `ops` は先頭から順に適用される
- `format` op を省略した場合、出力フォーマットは `output` の拡張子から自動判定される
- 出力ディレクトリは自動作成される

### 3. 実行する

Claude Code では:

```bash
bash .claude/skills/imgedit-sharp/scripts/edit-image.sh <spec.json>
```

Codex では:

```bash
bash .agents/skills/imgedit-sharp/scripts/edit-image.sh <spec.json>
```

成功時は `Image written: <output> (<format> <width>x<height>, <bytes> bytes)` が出力される。
exit code: `2` = spec の形式エラー（メッセージに従って spec を修正）、`1` = 画像処理エラー（sharp のエラーメッセージを確認）、`3` = Node.js バージョン不足。

`allowed-tools` は Claude Code 向けの権限指定であり、Codex では本文の実行例に従って実行する。

### 4. 結果を確認する

出力の寸法・サイズを確認し、必要に応じて spec を調整して再実行する:

```bash
bash .claude/skills/imgedit-sharp/scripts/edit-image.sh --info <output>
```

## ops リファレンス

| op                 | 主なパラメータ                                                                                                    | 説明                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `resize`           | `width`, `height`, `fit` (cover/contain/fill/inside/outside), `background`, `withoutEnlargement`                  | リサイズ。片方だけ指定でアスペクト比維持                     |
| `crop` / `extract` | `left`, `top`, `width`, `height`（すべて必須）                                                                    | 矩形の切り抜き                                               |
| `rotate`           | `angle`, `background`                                                                                             | 回転。90 の倍数以外は `background` で余白色を指定            |
| `flip` / `flop`    | -                                                                                                                 | 上下反転 / 左右反転                                          |
| `extend`           | `top`, `bottom`, `left`, `right`, `background`                                                                    | 余白の追加（パディング）                                     |
| `trim`             | `threshold`                                                                                                       | 縁の単色領域を自動トリム                                     |
| `flatten`          | `background`                                                                                                      | アルファチャンネルを背景色に合成                             |
| `grayscale`        | -                                                                                                                 | グレースケール化                                             |
| `negate`           | -                                                                                                                 | 色反転                                                       |
| `blur`             | `sigma` (0.3-1000)                                                                                                | ガウスぼかし                                                 |
| `sharpen`          | `sigma`                                                                                                           | シャープ化                                                   |
| `tint`             | `color`（必須）                                                                                                   | 色調を指定色に寄せる                                         |
| `modulate`         | `brightness`, `saturation`, `hue`, `lightness`                                                                    | 明度・彩度・色相の調整（1.0 が等倍）                         |
| `composite`        | `input`（必須）, `gravity` または `left` + `top`, `blend`                                                         | 画像の合成（透かし・ロゴ等）。`input` は画像パス（SVG も可） |
| `format`           | `format`（必須: jpeg/png/webp/avif/gif/tiff）, `quality`, `lossless`, `compressionLevel`, `effort`, `progressive` | 出力フォーマットとエンコードオプションの明示指定             |

色（`background` / `color`）は CSS 色文字列（`"#rrggbb"`, `"rgba(0,0,0,0.5)"`, `"white"` 等）で指定する。

### よく使う spec 例

サムネイル生成（アスペクト比を保って収める）:

```json
{
  "input": "photo.jpg",
  "output": "thumb.webp",
  "ops": [{ "type": "resize", "width": 320, "height": 320, "fit": "inside" }]
}
```

透かしを右下に合成:

```json
{
  "input": "photo.jpg",
  "output": "out.jpg",
  "ops": [{ "type": "composite", "input": "logo.png", "gravity": "southeast" }]
}
```

PNG スクリーンショットの軽量化（AVIF 化）:

```json
{
  "input": "screenshot.png",
  "output": "screenshot.avif",
  "ops": [{ "type": "format", "format": "avif", "quality": 60 }]
}
```

特定領域を赤枠で囲んで強調（スクリーンショット注釈）:

枠線だけの SVG（`fill="none"`）を作り、`composite` で座標指定して重ねる。囲みたい領域の座標が不明な場合は先に `--info` で画像寸法を確認する。

```xml
<!-- red-box.svg: 約 200x200 の領域を stroke-width 4 で囲む例 -->
<svg xmlns="http://www.w3.org/2000/svg" width="208" height="208">
  <rect x="2" y="2" width="204" height="204" fill="none" stroke="red" stroke-width="4" rx="6"/>
</svg>
```

```json
{
  "input": "screenshot.png",
  "output": "annotated.png",
  "ops": [{ "type": "composite", "input": "red-box.svg", "left": 96, "top": 46 }]
}
```

- SVG の `stroke` は辺の中心線に描かれるため、キャンバスを `stroke-width` ぶん大きめに取り、`x`/`y` を `stroke-width / 2` オフセットするとはみ出さない
- 同じ要領で円囲み（`<circle>`）・矢印（`<line>` / `<path>`）・注釈テキスト（`<text>`）も合成できる。複数箇所の注釈は、入力画像と同寸の SVG 1 枚に絶対座標で描いて `left: 0, top: 0` で重ねる方が spec がシンプルになる

## 制約

- 操作は 1 つの sharp パイプラインに連結される。同種の操作を複数回適用する場合（例: resize → composite → resize）は spec を分けて 2 段階で実行する
- アニメーション GIF の全フレーム処理は対象外（先頭フレームのみ処理される）
- WASM 実行のため native 版 sharp より数倍遅いが、通常の画像 1 枚の処理は数十〜数百 ms で完了する
- SVG 入力のテキストはフォールバックフォントで描画される。特定フォントの再現はできず、実行時に `Fontconfig error` が stderr に出るが動作に影響はない

## リファレンス

設計意図・sharp wasm32 選定の経緯・vendoring 方式の詳細は `references/design-plan.md` を参照。
