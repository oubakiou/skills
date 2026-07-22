# imgedit-sharp 設計計画

このドキュメントは `imgedit-sharp` skill の設計意図・構成・割り切りを記録するためのものである。skill の `references/design-plan.md` として配置し、将来の改修・移植・監査時の参照資料とする。

## 目次

1. [スキルの目的](#1-スキルの目的)
2. [エンジン選定の経緯](#2-エンジン選定の経緯)
3. [動作環境と制約](#3-動作環境と制約)
4. [ディレクトリ構成](#4-ディレクトリ構成)
5. [実行フロー](#5-実行フロー)
6. [spec と実装の設計](#6-spec-と実装の設計)
7. [テストケース](#7-テストケース)
8. [設計上の割り切り](#8-設計上の割り切り)
9. [将来的な拡張候補](#9-将来的な拡張候補)
10. [参考資料](#10-参考資料)

## 1. スキルの目的

エージェントのワークフロー中に発生する既存画像の加工（スクリーンショットの crop / resize、ドキュメント用画像のフォーマット変換・軽量化、サムネイル生成、透かし合成等）を、追加インストールなしのオフライン自己完結で実行する。

画像の新規生成は対象外（`delegate-imagegen` の守備範囲）。Vega-Lite チャートの生成は `dataviz-svg` の守備範囲。

### アーキテクチャ概要

```
main agent
  ├─ 編集 spec (JSON) を作成 → <spec>.json に保存
  │
  └─ Bash: edit-image.sh <spec>.json
       │
       │  ┌───────────────────────────────────┐
       │  │ edit-image.ts                      │
       │  │  vendored sharp (wasm32) を require │
       │  │  ops を sharp パイプラインに変換     │
       │  │  <input> → ops 適用 → <output>      │
       │  └──────────┬────────────────────────┘
       │             │ 加工済み画像ファイル
       ▼
  main agent: 結果確認 (edit-image.sh --info)
```

本スキルはセキュリティ防御層ではなく、画像加工ワークフローを支援するユーティリティである。ユーザー（または main agent）が明示的に指定したローカル画像のみを処理し、ネットワークアクセスは行わない。

## 2. エンジン選定の経緯

### 検討した候補（2026-07 時点の npm 実測値）

| 候補                     | サイズ (unpacked)      | ライセンス                               | 評価                                                                          |
| ------------------------ | ---------------------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| sharp (native)           | platform ごとに約 18MB | Apache-2.0 (+ libvips LGPL)              | ❌ `.node` は単一ファイルへバンドル不可。主要 3-4 platform 同梱で 50MB 超     |
| **sharp (wasm32)** ✅    | 約 11MB（依存込み）    | Apache-2.0 AND LGPL-3.0-or-later AND MIT | ✅ platform 非依存の単一 wasm。sharp の高レベル API と LLM の学習知識が活きる |
| wasm-vips                | 約 12.5MB              | MIT                                      | △ 同じ libvips エンジンだが API が低レベル                                    |
| @imagemagick/magick-wasm | 約 15.4MB              | Apache-2.0                               | △ バンドルは素直だが libvips より低速                                         |
| jimp                     | 約 3.3MB               | MIT                                      | △ pure JS で最軽量だが WebP/AVIF 非対応・低速                                 |

### sharp wasm32 を選んだ理由

`.temp/` でのスパイク検証により以下を確認した:

- `npm install --cpu=wasm32 sharp` で `@img/sharp-wasm32`（sharp 本体と同一バージョン）が導入される
- 構成は emscripten glue JS（約 150KB）+ 単一 `.wasm`（約 8.5MB）で、`dataviz-svg` の `resvg.wasm` と同じ platform 非依存の構図
- runtime 依存はすべて小さな pure JS（`@img/colour` / `detect-libc` / `semver` / `@emnapi/runtime` / `tslib`）
- node_modules ツリーを `vendor/` に切り出し、`createRequire` で解決すれば **package.json も npm install もなしで動作**する
- WebP / AVIF エンコード、SVG 入力（wasm 内に resvg を同梱）まで動作
- 性能は 4000×3000 → 800px の resize + JPEG 出力で約 40ms。WASM でもスキル用途には十分

### vendored node_modules 方式について

`dataviz-svg` は Vite で単一 `.mjs` にバンドルするが、本スキルは node_modules レイアウトのまま `scripts/vendor/node_modules/` に同梱する。sharp のローダーと emscripten glue が node_modules レイアウト（bare specifier の require）を前提としており、単一ファイルへのバンドルはロード機構の hack が必要になるため、素直に同梱する方が保守的に安全と判断した。

- `edit-image.ts` は `createRequire(new URL('vendor/anchor.cjs', import.meta.url))` で vendor/ 配下を解決基点にし、`require('sharp')` を vendored ツリーに解決させる
- リポジトリの `.gitignore` は `node_modules/` を除外するため、`!skills/imgedit-sharp/scripts/vendor/node_modules/` の negation で vendored ツリーのみ git 管理下に置く
- vendored ツリーは `vp check` の lint / fmt 対象外（`vite.config.ts` の `generatedIgnorePatterns`）
- 更新は skill ルートの `update-vendor.sh` で行う。型定義用に devDependencies へ同一バージョンの `sharp` を入れており、vendor 更新時は揃えて上げる

## 3. 動作環境と制約

- **実行環境は Node.js >= 23.6**: `edit-image.ts` を TypeScript のまま直接実行するため（リポジトリの guarded 系スキルと同じ要件）。sharp 自体の要件は Node-API v9（Node.js >= 20.9.0）でこれに包含される
- **オフライン自己完結**: vendored ツリーを同梱しているため、インストール後は追加ダウンロードなしで動作する
- **platform 非依存**: native binary を含まない。wasm32 ビルドは linux / macOS / Windows いずれの Node.js でも動作する
- **性能**: WASM 実行のため native 版 sharp の数倍遅い。ただし画像 1 枚あたり数十〜数百 ms であり、対話的なスキル用途では問題にならない
- **メモリ**: wasm ヒープ上で処理するため、極端に大きい画像（数億ピクセル級）は native 版より制約が厳しい

## 4. ディレクトリ構成

```
imgedit-sharp/
├── SKILL.md                          # スキル定義（トリガー条件・実行フロー・ops リファレンス）
├── THIRD_PARTY_NOTICES.md            # 同梱 third-party asset のライセンス表記
├── update-vendor.sh                  # vendored sharp の更新スクリプト（開発用）
├── scripts/
│   ├── edit-image.sh                 # エントリポイント（Node バージョンチェック + node 起動）
│   ├── edit-image.ts                 # spec パース + sharp パイプライン構築（テスト内蔵）
│   └── vendor/
│       └── node_modules/             # ⛔ update-vendor.sh で生成（直接編集しない）
│           ├── sharp/                # sharp 本体 (JS)
│           ├── @img/sharp-wasm32/    # libvips の WebAssembly ビルド（約 8.5MB）
│           ├── @img/colour/          # 色パース (pure JS)
│           ├── @emnapi/runtime/      # emscripten Node-API ブリッジ
│           ├── detect-libc/ semver/ tslib/
└── references/
    └── design-plan.md                # このドキュメント
```

## 5. 実行フロー

SKILL.md の実行フローを参照。要点:

1. 必要なら `edit-image.sh --info <image>` で入力画像の寸法・フォーマットを確認
2. 編集 spec (JSON) を作成（一時 spec は `.temp/` 配下）
3. `edit-image.sh <spec.json>` で実行
4. `--info` で出力を確認し、必要なら spec を調整して再実行

## 6. spec と実装の設計

### spec スキーマ

```json
{
  "input": "<入力画像パス>",
  "output": "<出力画像パス>",
  "ops": [ { "type": "<op名>", ...パラメータ }, ... ]
}
```

- パスは実行時の cwd 基準で解決する（`path.resolve`）。spec ファイルの位置には依存しない
- `ops` は配列順に sharp のメソッドチェーンへ変換される
- 出力フォーマットは `output` の拡張子から sharp が自動判定する。エンコードオプション（quality 等）が必要な場合は `format` op で明示する

### バリデーション方針

- `input` / `output` の存在と型、`ops` の各要素の `type` が既知であること、および欠落すると sharp 側で不可解な TypeError や暗黙の挙動変化になる必須フィールド（`crop`/`extract` の座標・寸法、`rotate.angle`、`tint.color`、`composite.input`、`format.format`）をスクリプト側で検証し、`SpecError`（exit code 2）で報告する
- それ以外のパラメータ検証は sharp 自体のバリデーションに委譲する（sharp のエラーメッセージは十分具体的）。sharp のエラーは exit code 1
- 未知の op type は許容しない（typo の握り潰しを防ぐ）

### ops → sharp メソッドの対応

各 op はほぼ 1:1 で sharp のメソッドに対応する（`resize` → `.resize()`、`crop`/`extract` → `.extract()`、`format` → `.toFormat()` 等）。op オブジェクトのキーは sharp のオプション名と揃えており、変換層を薄く保つ。

### 操作順序の制約

sharp は 1 インスタンス = 1 パイプラインであり、同種操作の 2 回適用（例: resize → composite → resize）は表現できない。この場合は spec を分割して 2 段階で実行する。SKILL.md の制約セクションに明記している。

## 7. テストケース

`edit-image.ts` の in-source test（vitest）で自動検証する:

1. **resize + 拡張子推論**: PNG 入力 → resize → `.webp` 出力で WebP に変換され、寸法がアスペクト比維持で正しい
2. **crop + format op**: crop の寸法が正確で、`format` op の jpeg / quality 指定が反映される
3. **出力ディレクトリ自動作成**: 存在しないネストされた出力パスでも成功する
4. **composite**: `gravity` 指定のオーバーレイ合成が成功し、ベース画像の寸法が維持される
5. **未知の op type**: `SpecError` で fail し、メッセージに op 名が含まれる
6. **存在しない spec**: `SpecError` で fail する
7. **imageInfo**: フォーマット・寸法・アルファ有無・ファイルサイズを返す

手動検証: `edit-image.sh` 経由の CLI 実行、`--info` モード、AVIF エンコード、SVG 入力の合成。

## 8. 設計上の割り切り

- **vendored node_modules を git 管理**: 約 11MB（うち wasm が 8.5MB）がリポジトリに入る。`dataviz-svg`（9.3MB）と同水準であり、オフライン自己完結・`gh skill install` 単独での動作を優先した
- **LGPL コンポーネントの同梱**: `@img/sharp-wasm32` は libvips (LGPL-3.0-or-later) を含む。sharp プロジェクト自身が同形態で配布しているものを、ライセンス表記（`THIRD_PARTY_NOTICES.md`）付きでそのまま再配布する
- **wasm32 の non-mainline 性**: sharp の wasm32 ビルドは prebuilt binary の中では傍流であり、将来のバージョンで配布形態が変わる可能性がある。`update-vendor.sh` と本ドキュメントで更新手順を残しておく
- **アニメーション画像は対象外**: GIF / アニメーション WebP の全フレーム処理（`animated: true`）は spec を複雑にするため初版では非対応
- **テキスト描画は対象外**: sharp の `text` 入力はフォント環境（fontconfig）依存であり、wasm 版での挙動保証が難しいため対象外。文字入れは SVG を `composite` の入力にすることで代替できる。SVG 内テキストはフォールバックフォントで描画される（検証済み。`Fontconfig error` が stderr に出るが無害）。特定フォントの再現が必要な場合は将来拡張のフォント同梱を検討する
- **操作パラメータの詳細検証はしない**: sharp のバリデーションに委譲する。スクリプト側での二重実装は保守コストに見合わない
- **ストリーム / Buffer 入出力はしない**: ファイルパス入出力に限定する。エージェントのワークフローではファイル経由が自然であり、spec の再現性も高い
- **LLM の sharp 知識に依存しない**: ops は SKILL.md のリファレンス表で完結するよう設計しており、sharp API の知識がなくても spec を書ける

## 9. 将来的な拡張候補

- **バッチ処理**: 複数入力（glob）への同一 ops 適用。大量のスクリーンショット変換等
- **アニメーション対応**: `animated: true` での GIF / WebP 全フレーム処理
- **SVG テキスト合成のヘルパー**: 文字入れ用の SVG 生成を補助する op またはドキュメント
- **EXIF 制御**: メタデータの保持 / 除去（`keepMetadata` / `withMetadata`）オプション
- **出力サイズ目標指定**: 「200KB 以下になるまで quality を下げる」等の自動調整

## 10. 参考資料

- sharp 公式ドキュメント -- https://sharp.pixelplumbing.com/
- sharp WebAssembly インストールガイド -- https://sharp.pixelplumbing.com/install/#webassembly
- @img/sharp-wasm32 -- https://www.npmjs.com/package/@img/sharp-wasm32
- wasm-vips (libvips WebAssembly ビルドの upstream) -- https://github.com/kleisauke/wasm-vips
- libvips -- https://www.libvips.org/
