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

修正方針は、`guarded-webfetch-codex` を「URL fetcher」として扱い続けるか、「Codex search/browse best-effort fetcher」として仕様を狭めるかで分岐する。

最小修正は、現状の設計上の制約をドキュメントとエラー出力に明示し、`fetch_success=false` 時の `error_message` を親へ伝播させることで、単なる `Codex fetch が失敗しました` ではなく取得不能理由を利用者が把握できるようにすることである。実装上は `pipe-sanitize-codex.ts` の `failFetch()` に Codex の `error_message` を渡す変更が候補になる。

修正前（現状）：

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

修正後の候補：

```ts
const failFetch = (errorMessage: string): never => {
  const detail = errorMessage.trim()
  throw new Error(
    detail.length > 0 ? `Codex fetch が失敗しました: ${detail}` : 'Codex fetch が失敗しました'
  )
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

根本修正としては、Codex の web/search 依存をやめ、隔離プロセス内の明示的な HTTP fetch 実装を持つ案がある。ただし、その場合は「Web 取得だけなら書き込み不要」「不要なシェル実行はしない」という現在の設計前提と衝突するため、脅威モデルと sandbox 方針の再設計が必要になる。

## 5. 受け入れ基準

- `https://zenn.dev/oubakiou/articles/b9db61885cd7be` が取得できない場合でも、失敗理由が `Codex fetch が失敗しました` だけで失われず、Codex 子の `error_message` が確認できること。
- 通常サンドボックス内で Codex CLI の read-only 初期化が失敗する場合、URL 固有の取得失敗と区別できる stderr が残ること。
- `fetch_success=false` の JSONL を `pipe-sanitize-codex.ts` に与えるテストで、`error_message` が例外メッセージに含まれること。
- `fetch_success=true` の既存正常系は引き続きサニタイズ済み JSON を返すこと。
- 既存 `vp test` / `vp check` が通過すること。

Zenn 本文を必ず取得できることは、最小修正の受け入れ基準には含めない。現状の Codex web/search 経路では任意 URL の本文取得を保証できないため、そこまで要求する場合は実装方式の変更を別タスクとして扱う。

## 6. テスト追加方針

`skills/guarded-webfetch-codex/scripts/pipe-sanitize-codex.ts` の in-source test に、`fetch_success=false` かつ `error_message` ありの JSONL を追加する。期待値は、例外メッセージに Codex 子が返した理由が含まれること。

- `extractRawText`: `fetch_success=false` の場合に `error_message` を失わず fail-closed することを検査する。
- `readStdin`: 既存の空 stdin / 上限超過テストはそのまま維持する。

E2E で Zenn URL を固定して取得成功を検査するテストは追加しない。外部サイト、検索インデックス、Codex CLI の web/search 挙動に依存し、安定した regression test になりにくいため。

## 7. 関連

- [skills/guarded-webfetch-codex/scripts/quarantine-fetch-codex.sh](../../skills/guarded-webfetch-codex/scripts/quarantine-fetch-codex.sh) — Codex 子プロセス起動と `--sandbox read-only` 固定
- [skills/guarded-webfetch-codex/scripts/pipe-sanitize-codex.ts](../../skills/guarded-webfetch-codex/scripts/pipe-sanitize-codex.ts) — Codex JSONL 抽出と `fetch_success=false` の fail-closed 処理
- [skills/guarded-webfetch-codex/references/design-plan.md](../../skills/guarded-webfetch-codex/references/design-plan.md) — Codex 版 webfetch の脅威モデルと設計上の割り切り
- [README.md](../../README.md) — guarded 系スキルの防御アーキテクチャと Codex 版の制約
