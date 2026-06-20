# [BUG] guarded-webfetch-codex が Zenn 記事 URL の本文取得に失敗する

`guarded-webfetch-codex` で `https://zenn.dev/oubakiou/articles/b9db61885cd7be` を取得しようとすると、Zenn 側は `HTTP/2 200` を返すにもかかわらず、Codex 子プロセス経由では本文を取得できず fail-closed する。失敗は 2 層あり、通常サンドボックス内では Codex CLI が `--sandbox read-only` 初期化時に書き込み要求で失敗し、サンドボックス外で初期化が通っても Codex の web/search 経路が対象 URL の本文を取得できず `fetch_success=false` になる。

## 1. 問題の構造

`guarded-webfetch-codex` は、任意 URL の本文取得を `codex --search exec` に委譲し、子 Codex の最終 JSONL `agent_message` をサニタイズして親へ返す設計になっている。一方で、Codex 子は Claude 版の `WebFetch only` のような URL fetch 専用ツール固定を持たず、実際の取得可否は Codex の web/search 経路と子プロセス実行環境に依存している。

今回の URL では、サンドボックス外の `curl -I -L --max-time 20 'https://zenn.dev/oubakiou/articles/b9db61885cd7be'` は `HTTP/2 200` を返すため、対象記事の削除や Zenn 側の 404 が直接原因ではない。通常実行では Codex CLI 自体が read-only 初期化で落ち、権限を外した切り分け実行では Codex が Zenn 本文を見つけられず、設計どおり `pipe-sanitize-codex.ts` が fail-closed している。

| 場所                                                                  | 状態                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 期待値                                                                | URL 指定の本文取得スキルとして、到達可能な Zenn 記事本文を `raw_text` に入れて返す    |
| `skills/guarded-webfetch-codex/scripts/quarantine-fetch-codex.sh:104` | `codex --search exec --sandbox read-only` 固定で実行する                              |
| `skills/guarded-webfetch-codex/scripts/pipe-sanitize-codex.ts:126`    | Codex の最終 JSON で `fetch_success=false` の場合、親へ内容を渡さず失敗させる         |
| `skills/guarded-webfetch-codex/references/design-plan.md:281`         | Codex 子のツール権限は厳密に固定できず、プロンプトと sandbox に依存すると明記している |
| `skills/guarded-webfetch-codex/references/design-plan.md:282`         | read-only 失敗時に追加権限へ昇格しない方針を明記している                              |

## 2. 推定される影響

失敗パターン：

- Codex CLI 初期化失敗: `codex-cli 0.139.0` で `--sandbox read-only` を使うと、環境によって `failed to initialize in-process app-server client: Read-only file system` が発生し、stdout が空になる。後段の sanitizer は `stdin が空です` で停止する。
- URL 本文取得失敗: Codex CLI の初期化が通っても、子 Codex の web/search 経路が Zenn 記事本文を取得できず、最終 JSON が `fetch_success=false` になる。`pipe-sanitize-codex.ts` は `Codex fetch が失敗しました` で停止する。
- 環境依存 failure: 同じ URL はサンドボックス外の `curl` では到達できるため、外部サイト障害ではなく、Codex 子プロセスのネットワーク / DNS / web-search 能力に依存した失敗として表面化する。

ユーザーから見ると「Zenn の URL が取得できない」ように見えるが、実際には `guarded-webfetch-codex` が URL fetcher ではなく Codex の検索・閲覧能力に依存していることが主因である。現在の fail-closed は安全側の挙動だが、到達可能な URL でも本文取得できないため、URL 指定 fetch スキルとしての期待とずれている。

## 3. 再現確認手順

1. リポジトリルートで Node.js と `codex` CLI が利用できることを確認する。
2. 通常サンドボックス内で次を実行する。

   ```bash
   bash skills/guarded-webfetch-codex/scripts/quarantine-fetch-codex.sh 'https://zenn.dev/oubakiou/articles/b9db61885cd7be'
   ```

3. **主確認 (stderr / stdout)**: 環境によって次のような read-only 初期化失敗が出る。

   ```text
   stdin が空です
   WARNING: proceeding, even though we could not create PATH aliases: Read-only file system (os error 30)
   Reading additional input from stdin...
   Error: failed to initialize in-process app-server client: Read-only file system (os error 30)
   ```

4. **副確認 (到達性)**: サンドボックス外のネットワーク到達性を切り分ける。

   ```bash
   curl -I -L --max-time 20 'https://zenn.dev/oubakiou/articles/b9db61885cd7be'
   ```

   対象 URL が `HTTP/2 200` を返すことを確認する。

5. **副確認 (Codex 子の最終 JSONL)**: Codex CLI の初期化が通る環境で同 URL を実行すると、子 Codex の最終 `agent_message` が `fetch_success=false` になることを確認する。観測例：

   ```json
   {
     "url": "https://zenn.dev/oubakiou/articles/b9db61885cd7be",
     "raw_text": "",
     "fetch_success": false,
     "error_message": "Web tool で対象ページを取得できませんでした。URL はキャッシュミスで開けず、検索結果にも出なかったため本文テキストを抽出できませんでした。"
   }
   ```

6. **能動確認 (比較 URL)**: 同じ通常サンドボックス内で `https://example.com` を指定しても read-only 初期化失敗が再現する場合、少なくともその失敗経路は Zenn URL 固有ではない。

注: `curl` による直接取得は `guarded-webfetch-codex` の実装経路ではない。到達性の切り分けには使えるが、Codex 子の web/search 経路が同じ結果を返す保証はない。

## 4. 修正方針

修正方針は 2 段階に分ける。

### 4.1 最小修正

最小修正は、現状の設計上の制約をドキュメントとエラー出力に明示し、`fetch_success=false` 時の `error_message` をサニタイズしたうえで親へ伝播させることで、単なる `Codex fetch が失敗しました` ではなく取得不能理由を利用者が把握できるようにすることである。実装上は `pipe-sanitize-codex.ts` の `failFetch()` に Codex の `error_message` を渡し、例外メッセージへ含める前に既存の `sanitize()` を通す。

修正前：

```ts
const failFetch = (): never => {
  throw new Error('Codex fetch が失敗しました')
}

export const extractRawText = (jsonl: string): CodexFetchOutput => {
  const lastMessage = extractLastAgentMessage(jsonl)
  const output = parseCodexFetchOutput(lastMessage)
  if (!output.fetch_success) {
    failFetch()
  }
  return output
}
```

修正後：

```ts
const formatFetchFailureMessage = (errorMessage: string): string => {
  const detail = sanitize('', '', errorMessage).text.trim()
  if (detail.length === 0) {
    return 'Codex fetch が失敗しました'
  }
  return `Codex fetch が失敗しました: ${detail}`
}

const failFetch = (errorMessage: string): never => {
  throw new Error(formatFetchFailureMessage(errorMessage))
}

export const extractRawText = (jsonl: string): CodexFetchOutput => {
  const lastMessage = extractLastAgentMessage(jsonl)
  const output = parseCodexFetchOutput(lastMessage)
  if (!output.fetch_success) {
    failFetch(output.error_message)
  }
  return output
}
```

この最小修正は失敗理由の可観測性を改善するが、Zenn 本文を取得できるようにはしない。

### 4.2 根本修正

根本修正として、Codex の `web_search` / search-browse 経路への依存をやめ、隔離プロセス内に Node.js 標準 `fetch()` ベースの direct HTTP fetcher を持つ。`guarded-webfetch-codex` を URL fetcher として扱い続けるなら、取得は LLM の検索・閲覧判断ではなく決定的なコードで実行する。

方針:

- `quarantine-fetch-codex.sh` から `node scripts/http-fetch-codex.ts "<URL>"` を起動する
- `http-fetch-codex.ts` は `fetch-output-schema.json` 互換の `{ url, raw_text, fetch_success, error_message }` JSON を stdout に出す
- `pipe-sanitize-codex.ts` は Codex JSONL ではなく fetcher JSON を検証し、既存の `sanitize()` とオリジン検証を適用する
- `codex --search exec` は主経路から外し、URL 本文取得には使わない
- HTML 抽出は追加依存なしの素朴な実装から始め、Zenn 相当 fixture と一般的な SSR HTML を対象にする

HTTP fetcher には次の制約を入れる。

- `http:` / `https:` のみ許可
- `GET` のみ実行
- リダイレクト回数上限を設け、各リダイレクト先を再検証する
- localhost、private IP、link-local、metadata endpoint 等を拒否する
- timeout と最大レスポンスサイズを強制する
- `content-type` は HTML / plain text / JSON / XML 系に制限する
- JavaScript 実行が必要な SPA の本文取得は保証しない

## 5. 受け入れ基準

### 5.1 最小修正

- `https://zenn.dev/oubakiou/articles/b9db61885cd7be` が取得できない場合でも、失敗理由が `Codex fetch が失敗しました` だけで失われず、サニタイズ済みの `error_message` が確認できること。
- `fetch_success=false` の入力を `pipe-sanitize-codex.ts` に与えるテストで、サニタイズ済みの `error_message` が例外メッセージに含まれること。
- `error_message` にチャットテンプレートや指示上書き語句が含まれる場合、生文字列ではなく `[FILTERED:...]` に無害化されること。
- `fetch_success=true` の既存正常系は引き続きサニタイズ済み JSON を返すこと。
- 既存 `vp test` / `vp check` が通過すること。

Zenn 本文を必ず取得できることは、最小修正の受け入れ基準には含めない。

### 5.2 根本修正

- `quarantine-fetch-codex.sh` の主経路が `codex --search exec` ではなく Node.js direct HTTP fetcher になること。
- direct HTTP fetcher が `fetch-output-schema.json` 互換 JSON を出力し、成功時は本文を `raw_text` に入れること。
- `https://zenn.dev/oubakiou/articles/b9db61885cd7be` または同等構造の fixture から本文を抽出できること。
- 危険 URL (`file:`, `javascript:`, localhost, private IP, link-local, metadata endpoint 等) が fail-closed されること。
- クロスオリジンリダイレクト、HTTPS→HTTP 降格、ポート変更が fail-closed されること。
- timeout、最大レスポンスサイズ、許可外 content-type が fail-closed されること。
- 取得した本文は既存 `sanitize()` を通り、`suspicious_patterns` / `had_invisible_chars` / `truncated` が従来どおり働くこと。
- 外部ネットワークに依存しない fixture ベースの単体テストが追加され、既存 `vp test` / `vp check` が通過すること。

## 6. テスト追加方針

### 6.1 最小修正

`skills/guarded-webfetch-codex/scripts/pipe-sanitize-codex.ts` の in-source test に、`fetch_success=false` かつ `error_message` ありの入力を追加する。期待値は、例外メッセージに失敗理由がサニタイズ済みで含まれること。

- `extractRawText`: `fetch_success=false` の場合に `error_message` を失わず、危険なマーカーを無害化して fail-closed することを検査する。
- `readStdin`: 既存の空 stdin / 上限超過テストはそのまま維持する。

### 6.2 根本修正

`http-fetch-codex.ts` の in-source test を追加し、外部ネットワークへ出ない fixture / ローカル mock server で検証する。

- 正常系: HTML / plain text / JSON / XML から本文テキストを抽出する
- Zenn 相当 HTML: 記事本文を含む fixture から本文を抽出する
- URL 検証: 非 HTTP scheme、localhost、private IP、metadata endpoint を拒否する
- リダイレクト: 許容リダイレクトを通し、クロスオリジンや HTTPS→HTTP 降格を拒否する
- content-type: 許可外 content-type を拒否する
- サイズ制限: 最大レスポンスサイズ超過で fail-closed する
- timeout: 応答遅延で fail-closed する
- pipe 連携: fetcher 成功 JSON が `pipe-sanitize-codex.ts` でサニタイズ済み JSON になる

E2E で Zenn 実 URL を固定して取得成功を検査するテストは追加しない。外部サイト、DNS、ネットワーク policy に依存し、安定した regression test になりにくいため。Zenn 実 URL は手動確認の対象に留める。

## 7. 関連

- [skills/guarded-webfetch-codex/scripts/quarantine-fetch-codex.sh](../../skills/guarded-webfetch-codex/scripts/quarantine-fetch-codex.sh) — direct HTTP fetcher 起動と pipe 接続のエントリポイント
- [skills/guarded-webfetch-codex/scripts/pipe-sanitize-codex.ts](../../skills/guarded-webfetch-codex/scripts/pipe-sanitize-codex.ts) — fetcher JSON 検証と `fetch_success=false` の fail-closed 処理
- [skills/guarded-webfetch-codex/references/design-plan.md](../../skills/guarded-webfetch-codex/references/design-plan.md) — direct HTTP fetcher 化後の脅威モデルと設計上の割り切り
- [README.md](../../README.md) — guarded 系スキルの防御アーキテクチャと Codex 版の制約
