# guarded-webfetch-gemini 設計計画

このドキュメントは `guarded-webfetch-gemini` skill の設計意図・構成・割り切りを記録するためのものである。skill の `references/design-plan.md` として配置し、将来の改修・監査・比較検討時の参照資料とする。

スキル本体（SKILL.md / scripts）は実装済みである。本ドキュメントは設計意図・脅威モデル・割り切りの参照資料として維持する。

## 目次

1. [スキルの目的](#1-スキルの目的)
2. [脅威モデル](#2-脅威モデル)
3. [トリガー条件](#3-トリガー条件)
4. [動作環境と制約](#4-動作環境と制約)
5. [ディレクトリ構成](#5-ディレクトリ構成)
6. [実行フロー](#6-実行フロー)
7. [サニタイザの処理層](#7-サニタイザの処理層)
8. [隔離プロセス仕様](#8-隔離プロセス仕様)
9. [テストケース](#9-テストケース)
10. [設計上の割り切り](#10-設計上の割り切り)
11. [既存スキルとの比較](#11-既存スキルとの比較)
12. [将来的な拡張候補](#12-将来的な拡張候補)
13. [残課題と未確定事項](#13-残課題と未確定事項)
14. [参考資料](#14-参考資料)

## 1. スキルの目的

指定された URL のコンテンツを Claude 親エージェントが扱う際、Gemini CLI 子プロセスを隔離 fetcher として使用し、プロンプトインジェクション攻撃の影響を抑制するためのガード層を提供する。

設計の核は `guarded-webfetch-claude` および `guarded-webfetch-codex` と同じく **「untrusted content と特権的判断・ツール実行の論理的分離」** にある。Gemini 子が Web 取得を担当し、その出力を静的サニタイザに通した結果だけを親 Claude に渡すことで、生の Web コンテンツが main agent のコンテキストに直接入ることを避ける。

本設計では次の 3 層を採用する。

1. **Gemini 子プロセスによる取得 (ハード)** — `gemini -p --policy <toml>` で Policy Engine による全ツール `deny` をベースに `web_fetch` のみ `allow` する。ツール権限制限としては Claude 版 (`--allowedTools "WebFetch"`) と同等の強度を持ち、Codex 版 (CLI 直のツール固定なし) よりは厳密
2. **静的サニタイザ (ハード)** — Gemini の `-o json` 出力を `pipe-sanitize-gemini.ts` にパイプし、`response` フィールド内の JSON 抽出、オリジン検証、Unicode 不可視文字除去、LLM マーカー無害化をランタイム強制する
3. **安全性フラグによる行動制御 (ソフト)** — `sanitize.ts` が出力する `suspicious_patterns`、`had_invisible_chars`、`truncated` 等をもとに、親 Claude が応答可否を判断する

### アーキテクチャ概要

```text
main Claude agent
  └─ Bash: quarantine-fetch-gemini.sh "<url>"
       │
       │  パイプ内部:
       │  ┌────────────────────────────────────────────┐
       │  │ 隔離プロセス (gemini -p --policy …)        │
       │  │  web_fetch のみ allow / -o json で出力     │
       │  │  → {response, stats, error} の固定ラッパー │
       │  └──────────┬─────────────────────────────────┘
       │             │ stdout (JSON wrapper)
       │             ▼
       │  ┌────────────────────────────────────────────┐
       │  │ pipe-sanitize-gemini.ts                    │
       │  │  wrapper.response → 内部 JSON 抽出 →        │
       │  │  schema 検証 → sanitize()                  │
       │  └──────────┬─────────────────────────────────┘
       │             │ stdout (サニタイズ済みJSON)
       ▼
  main Claude agent のコンテキスト: サニタイズ済みテキスト + flags のみ
```

この skill はインジェクション対策の **緩和策** であり、完全防御ではない。Gemini CLI は Policy Engine によりツール権限を強制できる一方で、JSON schema 強制が無いため、形式崩しのリスクは Claude 版より高い。

## 2. 脅威モデル

想定する攻撃は `guarded-webfetch-claude` と同じセットを基準に、Gemini 固有の差分を加える。

共通:

- **不可視 Unicode 攻撃**: Tag characters (U+E0000-U+E007F)、zero-width 文字、bidi オーバーライドによる不可視命令埋め込み
- **HTML 構造を使った隠蔽**: HTML コメント、`<script>` / `<style>` 内テキスト、`display:none` / `visibility:hidden` / `opacity:0` などの不可視 CSS 要素。Gemini の `web_fetch` ツールの HTML→テキスト変換ロジックは Anthropic WebFetch 以上に詳細が非公開で、変換を通過する可能性は完全には否定できない
- **LLM チャットテンプレート擬装**: `<|im_start|>`, `</untrusted_content>`, `[INST]`, `Human:` などのマーカーで役割境界の脱出を試みる
- **間接的指示注入**: "ignore previous instructions", "you are now", "new instructions:" などのパターン
- **exfiltration 試行**: 取得コンテンツ内の URL や画像タグ経由でのデータ漏洩誘導
- **URL 改竄**: 要求した URL と異なるオリジンのコンテンツを返し、親に別サイトの内容を誤認させる試み
- **ツール権限の横滑り**: Gemini 子が `web_fetch` 以外のツール（`run_shell_command`, `read_file` 等）を使おうとするリスク
- **`[FILTERED]` / `[ESCAPED:]` マーカーの悪用**: sanitize.ts の付与マーカーとの区別を曖昧にする試み

Gemini 固有:

- **JSON 形式崩し**: Gemini には `--json-schema` 強制が無いため、`response` フィールド内のテキストが指定形式を逸脱する。指示無視・整形崩し・JSON 偽装が起こりうる
- **`web_fetch` のローカル fallback**: Gemini API の `urlContext` が失敗した場合に「ローカルマシンから raw 取得」にフォールバックする挙動が `web_fetch` ツールに存在する。sandbox 越しでも file: スキームへの干渉や local listener への到達を試みるリスク
- **`GEMINI.md` 経由のコンテキスト混入**: Gemini CLI は `GEMINI.md` の memory 機能を持つ。隔離 cwd 外に `GEMINI.md` が置かれていると、それが Gemini 子のシステム指示に取り込まれる可能性

想定しない攻撃:

- モデル重み自体への攻撃
- 自然言語で巧妙に埋め込まれた高度なソーシャルエンジニアリング
- 親 Claude がスキルをバイパスして直接 Web コンテンツを読む運用ミス
- Gemini API キーの盗用や Google アカウント乗っ取り（OS / IAM レイヤの問題）

## 3. トリガー条件

以下のいずれかに該当するとき発火させる。

- ユーザーが URL を提示し、その内容取得・要約・分析を要求した
- 親を Claude に保ったまま、子 fetcher として Gemini を使いたい
- Web コンテンツを Claude 親のコンテキストに直接入れたくない

以下の場合は本スキルの対象外とする。

- Web 検索クエリの実行が主目的である場合（`guarded-websearch-*` の領域）
- Claude 子の `WebFetch` で十分な場合（`guarded-webfetch-claude`）
- Codex 子で十分な場合（`guarded-webfetch-codex`）

ローカルファイルについては、保存場所ではなく出所で判断する。外部由来の HTML / Markdown / テキストをローカル保存してから読む場合も、本質的には同じ脅威モデルを持つ。

## 4. 動作環境と制約

### 前提条件

- Node.js 23.6 以降
- `gemini` CLI v0.40.x 以降がインストール済みであること (本設計の PoC は v0.40.0 で実施)
- Gemini が認証済みであること（Google アカウントログイン (`~/.gemini/oauth_creds.json`) または `GEMINI_API_KEY` 環境変数）
- `gemini -p` の headless モードで `web_fetch` ツールが利用可能であること
- **`--skip-trust` (または `GEMINI_CLI_TRUST_WORKSPACE=true` 環境変数) が必須**。指定しないと workspace trust 未確認の cwd では headless が exit code 55 で停止する
- Linux 環境で `--sandbox` を有効化する場合、`GEMINI_SANDBOX=docker|podman|runsc|lxc` のいずれかで**バックエンドを明示指定**する必要がある（Linux にデフォルトバックエンドは存在しない）
- gVisor (runsc) がインストール済みであれば `GEMINI_SANDBOX=runsc` で sandbox を有効化する。未インストールの場合は sandbox なしで動作する（URL 入口検証と Policy Engine による多層防御で代替）。セットアップ手順は下記参照

### gVisor (runsc) セットアップ手順

gVisor (runsc) が利用可能な環境では多層防御の一層として sandbox を有効化し、ローカル fallback リスク (§10 参照) の軽減に寄与させる。未インストールの場合は sandbox なしで動作する（主たる緩和層は URL 入口検証 + Policy Engine の `* deny` であり、sandbox はそれに上乗せする位置づけ）。可能な限りインストールを推奨する。以下は Linux 環境でのセットアップ手順である。検証は devcontainer (Docker-in-Docker 構成、arm64、Linux 6.10.14-linuxkit) + Gemini CLI v0.40.1 で実施した。

#### 1. runsc バイナリのインストール

```bash
ARCH=$(uname -m)  # x86_64 or aarch64
sudo wget -q "https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}/runsc" \
  -O /usr/local/bin/runsc
sudo chmod +x /usr/local/bin/runsc
runsc --version  # release-YYYYMMDD.0 が表示されれば成功
```

#### 2. Docker ランタイムへの登録

```bash
# daemon.json が既に存在する場合は runtimes キーをマージすること
sudo mkdir -p /etc/docker
echo '{"runtimes": {"runsc": {"path": "/usr/local/bin/runsc"}}}' \
  | sudo tee /etc/docker/daemon.json

# dockerd に設定リロードを通知
sudo kill -HUP $(pidof dockerd)
```

リロード後、`docker info` の `Runtimes` 行に `runsc` が表示されることを確認する。

```bash
docker info | grep -i runtime
# 期待出力: Runtimes: io.containerd.runc.v2 runc runsc
```

#### 3. 動作確認

```bash
# (a) Docker 単体での gVisor 確認
docker run --rm --runtime=runsc alpine echo "gVisor works!"

# (b) Gemini CLI + gVisor sandbox での確認
tmpdir=$(mktemp -d)
(cd "$tmpdir" && \
  GEMINI_SANDBOX=runsc gemini -p "respond with exactly one word: pong" \
    --skip-trust --sandbox -o json)
rm -rf "$tmpdir"
```

(b) の出力に `"response": "pong"` を含む JSON が返れば成功。

#### 検証時の注意事項

- **arm64 環境での sandbox イメージ非互換**: Gemini CLI の sandbox イメージ `us-docker.pkg.dev/gemini-code-dev/gemini-cli/sandbox:0.40.0` は `linux/amd64` であり、`arm64` ホストでは `WARNING: The requested image's platform (linux/amd64) does not match the detected host platform (linux/arm64/v8)` が stderr に出力される。通常の Docker では QEMU エミュレーション経由で起動できる場合がある一方、`runsc` ではこの環境で `failed to load /usr/local/bin/docker-entrypoint.sh: exec format error` となり起動できなかった。そのため本スキルでは `arm64` で sandbox を有効化しない
- **Docker-in-Docker (DinD) 環境**: devcontainer 等の DinD 構成では、`dockerd` がコンテナ内で動作しているため `sudo kill -HUP $(pidof dockerd)` で設定をリロードできる。ホストの Docker socket をマウントしている構成 (Docker-from-host) では、ホスト側の `daemon.json` を変更し、ホスト側の `dockerd` を再起動する必要がある
- **systemd が無い環境**: devcontainer では `systemctl restart docker` が使えないため、`kill -HUP` によるリロードが唯一の手段となる
- **無害な stderr ノイズ**: `Ripgrep is not available. Falling back to GrepTool.` は Gemini CLI の通常出力であり、gVisor sandbox の動作には影響しない

### Gemini CLI 固有の重要事項

- **`-o json` の出力ラッパー実体**: 成功時は `{session_id, response, stats}` の 3 フィールド (PoC 確認済み)。失敗時は `error` フィールドが追加される。`response` には model のテキスト出力（指示通りなら JSON 文字列）が入る。ユーザー定義 schema を強制する `--json-schema` 相当は CLI に**存在しない**
- **`response` フィールドはサニタイズされない**: PoC 確認済み。model の出力は標準 JSON エスケープ (`\n`, `\t`, `\"` 等) のみ適用された形で `response` に入る。ANSI escape など異常な制御文字を防ぐ目的の `--raw-output` は本スキルでは**不要**
- **Policy Engine は強力**: `--policy <toml>` で `*` を `deny`、`web_fetch` のみ `allow` にできる。`deny` 決定されたツールは「モデルに見えない」ため、ツール選択の段階から候補に上がらない（context window も節約される）
- **`--policy` の優先度は実質 Admin tier 相当**: PoC 確認済み。User tier (`~/.gemini/policies/`) で priority 999 (最大) の deny がある状態でも、`--policy` 経由のルールが override する。これは公式 Policy Engine docs の tier 表 (Default=1 / Extension=2 / User=4 / Admin=5) の数学的計算と矛盾するが、実機挙動として確認できた範囲では `--policy` は User tier deny を確実に上書きできる
- **モデルは deny されたツールの代替に逃げる**: PoC 確認済み。`web_fetch` だけ deny して放置すると Gemini は `google_web_search` などの別ツールで目的を達成しようとする。本スキルの policy では「`* deny` + `web_fetch allow`」で**全ツール抑止 → web_fetch のみ allow** にする必要がある (個別の web 系ツールを羅列して deny するアプローチでは漏れる)
- **Plan Mode と headless の干渉**: `--approval-mode plan` では `web_fetch` でも常に user approval を要求する仕様で、headless 時の `ask_user` は `deny` として扱われる。よって本スキルでは `--approval-mode default` を使い、Policy で明示的に `allow` する
- **`web_fetch` のローカル fallback**: Gemini API (urlContext) 失敗時にローカル raw 取得に fallback する仕様が公式 docs で明記。PoC でも stderr に `[WebFetchTool] Primary fetch failed, falling back: ...` が観測された。主たる緩和は URL 入口検証 (private host/IP deny) と Policy Engine の `* deny` で行い、policy で `read_file` 系ツールも deny する。runsc が利用可能な環境では `--sandbox` のファイルシステム隔離を多層防御の一層として上乗せする (sandbox 越しの遮断確認は §13 残課題)
- **デフォルトモデル**: PoC では `gemini-3-flash-preview` が選ばれた。preview ラベル付きで安定性が変動する可能性があるため、本スキルでは `-m` で明示固定する。実装では OAuth 無料枠でのレートリミット耐性と応答速度のバランスを考慮し `gemini-3.1-flash-lite-preview` をデフォルトとした（`GEMINI_MODEL` 環境変数で上書き可能）。stable 版が出たら差し替える
- **GEMINI.md の自動読込**: 隔離 cwd を `mktemp -d` で空ディレクトリにすることで cwd / project レベルの `GEMINI.md` 読込は塞げる。ただし global `~/.gemini/GEMINI.md` は HOME を whitelist している以上 Gemini 子に読み込まれる (§10 リスクとして記載)
- **`.env` の自動読込**: Gemini CLI は cwd から上方再帰で `.env` を探す。`mktemp -d "$PWD/.temp/guarded-webfetch-gemini/run-XXXXXXXX"` で切るパスが上位プロジェクトの `.env` を拾う可能性があるため、設計上は隔離スクリプト内で `GEMINI_CLI_NO_DOTENV` 等の抑止フラグの有無を検証するか、`HOME` 配下の `.gemini/.env` を信頼境界として明示する必要がある
- **Workspace trust スキップ**: `--skip-trust` で trust チェックを bypass する以外に、`GEMINI_CLI_TRUST_WORKSPACE=true` を whitelist に通す方法もある。本スキルは `--skip-trust` を採用する (CLI 引数として明示的、env 経路を最小化)

### 環境変数の取り扱い (whitelist 方式)

`quarantine-fetch-gemini.sh` は `env -i` で親 env を全消去した上で、以下のみを明示的に通す。攻撃面を最小化しつつ、API key 認証と Google アカウント (ADC) ログインの両方をサポートするための設計。

| 環境変数                         | 通す理由                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `PATH`                           | `gemini` バイナリ・サンドボックスバックエンド (Docker / Podman 等) の実行に必須                                              |
| `HOME`                           | Gemini CLI が `~/.gemini/` 配下の認証トークンや設定を読むために必要                                                          |
| `GEMINI_API_KEY`                 | API key 認証時の主要経路                                                                                                     |
| `GOOGLE_API_KEY`                 | Google AI Studio 経由の代替認証                                                                                              |
| `GOOGLE_APPLICATION_CREDENTIALS` | ADC (Application Default Credentials) のサービスアカウント JSON パス                                                         |
| `GOOGLE_GENAI_USE_VERTEXAI`      | Vertex AI 経由のときに必要                                                                                                   |
| `GOOGLE_CLOUD_PROJECT`           | Vertex AI 経由でのプロジェクト指定                                                                                           |
| `LANG` / `LC_ALL` / `TZ`         | ロケール・タイムゾーン依存の出力差異を避けるための情報。`-o json` の構造には影響しないが、エラー文言に出る場合があるため許容 |

明示的に**通さない** env の代表例:

- `GEMINI_SANDBOX` — 本スキルではスクリプト内で runsc の利用可否を検出し、利用可能な場合のみ `GEMINI_SANDBOX=runsc` を `env -i` の引数として渡す。外部 env からの上書きは許可しない
- `GEMINI_CLI_TRUST_WORKSPACE` — `--skip-trust` を CLI 引数で渡すため env 経由は不要
- `SANDBOX_MOUNTS` — 不要なマウントを増やす経路を塞ぐため不可
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` などの他社認証情報 — Gemini 子からの漏洩経路を塞ぐ
- `CLAUDE_*` — 親 Claude 側の状態を Gemini 子に渡さない
- `GEMINI.md` 自動読込関連の env が将来追加された場合は明示的に弾く

`env -i` で完全置換 (`env -i PATH="$PATH" HOME="$HOME" ... gemini ...`) する形を取り、blacklist 方式のリストアップ漏れリスクを排除する。

## 5. ディレクトリ構成

```text
guarded-webfetch-gemini/
├── SKILL.md
├── references/
│   ├── design-plan.md
│   ├── fetch-output-schema.json
│   └── quarantine-fetch-policy.toml
└── scripts/
    ├── check-node-version.sh
    ├── quarantine-fetch-gemini.sh
    ├── pipe-sanitize-gemini.ts
    └── sanitize.ts
```

- `sanitize.ts` は `guarded-webfetch-claude` と同等のロジックを持つ独立したコピーとして保持する。異なる LLM 向け skill 間での import / re-export は行わない（skill 単体での独立性・可搬性を優先）
- `check-node-version.sh` は main agent の事前チェックと `quarantine-fetch-gemini.sh` の冒頭からのサブプロセス呼び出しの両方で使う多層防御 (claude / codex 版と同じ運用)
- 一時ファイルや隔離用 cwd は `.temp/guarded-webfetch-gemini/` 配下に実行ごとの `run-XXXXXXXX/` を `mktemp -d` で切り、`trap EXIT` で削除する。並列起動 (最大 5 件) と「毎回クリーン」を両立し、`GEMINI.md` 等の前回残留ファイルが次回プロセスに混入しないようにするため
- `quarantine-fetch-policy.toml` は Gemini Policy Engine 用の TOML ファイル

## 6. 実行フロー

### ステップ 0: 前提条件チェック (最初に必ず実行)

```bash
bash .claude/skills/guarded-webfetch-gemini/scripts/check-node-version.sh
```

このチェックは SKILL.md のステップ 0 として main agent が Bash ツールで実行する。Node.js 23.6 未満の場合はスクリプトが exit code 3 で終了するので、ユーザーに以下を伝えて中止する。

> この skill は Node.js 23.6 以降を必要とします（TypeScript を追加ツールなしで直接実行するため）。現在の Node バージョンは `<取得したバージョン>` です。`nvm install --lts` 等で新しいバージョンをインストールしてから再度お試しください。

`<取得したバージョン>` には `check-node-version.sh` が stderr に出力する `(現在: vXX.YY.Z)` 部分の値を埋める。`scripts/quarantine-fetch-gemini.sh` も冒頭で同じバージョンチェックを行う。これは多層防御として残しており、main agent が事前チェックを省いた場合でも fetch 実行前に必ず止まる。

### ステップ 1: URL の特定

- 明示的な URL をそのまま使う
- 複数 URL は URL ごとに個別処理する
- 並列処理は最大 5 件までとする（Gemini API のレートリミット配慮）

### ステップ 2: fetch + sanitize

各 URL に対して次を実行する。

```bash
bash .claude/skills/guarded-webfetch-gemini/scripts/quarantine-fetch-gemini.sh '<対象URL>'
```

`quarantine-fetch-gemini.sh` は以下を行う。

1. Node.js と `gemini` CLI の存在確認 (`check-node-version.sh` でバージョン強制)
2. URL の入口検証 (`http://` / `https://`、禁止文字、長さ上限 2048)
3. `GEMINI_API_KEY` または OAuth 認証済み状態の確認
4. `mktemp -d "$PWD/.temp/guarded-webfetch-gemini/run-XXXXXXXX"` で隔離用 cwd を作成し、`trap EXIT` で削除
5. 隔離 cwd 配下から `env -i` + whitelist で以下のコマンドを実行

   ```bash
   # sandbox_env / sandbox_flag は runsc 利用可能時のみ設定される (後述)
   timeout 60 env -i \
     PATH="$PATH" HOME="$HOME" \
     GEMINI_API_KEY="${GEMINI_API_KEY:-}" \
     GOOGLE_API_KEY="${GOOGLE_API_KEY:-}" \
     GOOGLE_APPLICATION_CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS:-}" \
     GOOGLE_GENAI_USE_VERTEXAI="${GOOGLE_GENAI_USE_VERTEXAI:-}" \
     GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-}" \
     LANG="$LANG" LC_ALL="${LC_ALL:-}" TZ="${TZ:-}" \
     $sandbox_env \
     gemini \
       --skip-trust \
       $sandbox_flag \
       --policy "$skill_dir/references/quarantine-fetch-policy.toml" \
       --approval-mode default \
       -m "$GEMINI_MODEL" \
       -o json \
       -p "$PROMPT"
   ```

   スクリプト内で `runsc` の存在を検出し、sandbox 引数を動的に構成する。arm64 環境では Gemini CLI の sandbox Docker イメージが amd64 向けであり、runsc で exec format error となるため x86_64 のみ有効化する:

   ```bash
   host_arch="$(uname -m)"
   if [ "$host_arch" = "x86_64" ] \
       && command -v runsc &>/dev/null \
       && docker info 2>/dev/null | grep -q runsc; then
     sandbox_env="GEMINI_SANDBOX=runsc"
     sandbox_flag="--sandbox"
   else
     sandbox_env=""
     sandbox_flag=""
   fi
   ```

   - `timeout 60`: プロセスレベルのハードリミット (60 秒)。Gemini CLI に `--max-turns` 相当が無いため、無限ループや応答遅延による API コスト暴走を防ぐ。タイムアウト時は exit code 124 で終了
   - `--skip-trust`: workspace trust チェックを bypass (PoC 確認: 無いと exit code 55 で停止)
   - `--sandbox` + `GEMINI_SANDBOX=runsc`: gVisor (runsc) が利用可能な場合のみ有効化。`runsc` バイナリの存在と Docker ランタイムへの登録の両方を確認する。利用不可の場合は sandbox なしで続行し、URL 入口検証と Policy Engine による多層防御で代替する
   - `-m "$GEMINI_MODEL"`: モデルを明示固定する。デフォルトは `gemini-3.1-flash-lite-preview`（OAuth 無料枠でのレートリミット耐性考慮）。`GEMINI_MODEL` 環境変数で上書き可能

6. Gemini の `-o json` 出力を `pipe-sanitize-gemini.ts` にパイプする。URL を CLI 引数として渡し、オリジン検証に使用する

   ```bash
   ... gemini -p ... "<プロンプト>" \
     | node --strip-types "$skill_dir/scripts/pipe-sanitize-gemini.ts" "$url"
   ```

7. パイプの最終 stdout を呼び出し元（main Claude）へ返す

Gemini 子に与えるプロンプトでは次を要求する。

- 対象 URL の本文テキスト取得
- `web_fetch` ツールのみを使うこと
- `raw_text` は可能な限り原文を保つこと
- 50,000 文字超は先頭 50,000 文字に切り詰めること
- 最終出力は次の JSON オブジェクトのみとすること（前後にテキスト無し）
  ```json
  {
    "url": "...",
    "raw_text": "...",
    "fetch_success": true,
    "error_message": ""
  }
  ```
- `web_fetch` が失敗した場合は `fetch_success: false`、`error_message` にエラー詳細を設定すること

### ステップ 3: JSON 抽出とサニタイズ

`pipe-sanitize-gemini.ts` は以下を行う。

1. CLI 引数の URL を検証（`http://` または `https://` のみ許可）
2. stdin から Gemini の `-o json` ラッパー全体を読む
3. ラッパーを JSON parse し、`session_id`（string）、`response`（string）、`stats`（object）、`error`（optional）を取り出す
4. `error` フィールドが存在すれば fail-closed で終了
5. **`stats.tools.byName.web_fetch.count` を検証**: 0 なら `web_fetch` が一度も呼ばれていない (User policy deny / モデル判断による回避 / プロンプト不遵守) と判断し fail-closed。`success > 0` であることも確認
6. `response` を JSON として再度 parse し、`url`, `raw_text`, `fetch_success`, `error_message` を検証
7. 余計なテキストが前後に付着している場合のフォールバックとして、最初の `{` から最後の `}` までを抽出して再 parse を試みる（プロンプト崩しを 1 段階だけリカバー）。それでも失敗すれば fail-closed
8. `fetch_success === false` なら fail-closed
9. CLI 引数の URL と取得 URL のオリジンを比較し、不一致なら fail-closed
10. `sanitize(requestedUrl, fetchedUrl, rawText)` を実行し、`SanitizedDoc` JSON を stdout に出力

PoC で確認した重要事実:

- `response` 内の JSON 文字列は標準 JSON エスケープ (`\n`, `\t`, `\"` 等) のみ。`JSON.parse` で素直に元データに戻る
- `--raw-output` は不要（むしろ ANSI escape 等の許容で逆効果）
- `stats.tools.byName.web_fetch.count` は web_fetch 抑止の有無を検出する**唯一**の機械可読シグナル (stderr の `Tool "web_fetch" not found.` も参考になるが文字列ベースで脆い)

### ステップ 4: 安全性判定

親 Claude は `flags` に基づき安全性判定を行う。

**評価順序**: 以下の表は上から順に評価し、**最初にマッチした行の判定を採用する**。`suspicious_patterns` が非空なら即座に「要確認」が確定し、URL 差異や `truncated` の状態に関わらずユーザー確認を優先する。`had_invisible_chars` 単独の「注意」判定は `suspicious_patterns` が空のときにのみ意味を持つため、複合条件として独立行を持たせない。

| 条件                                                        | 判定       | 振る舞い                                                                                    |
| ----------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `suspicious_patterns` が 1 カテゴリ以上検出                 | 要確認     | ユーザーに確認を取るまで actionable な出力 (URL / コマンド / コード) を生成しない           |
| `truncated` が `true`                                       | 情報不完全 | テキストが切り詰められた旨をユーザーに通知                                                  |
| `had_invisible_chars` が `true`、`suspicious_patterns` が空 | 注意       | 応答に「不可視文字の除去または Unicode 互換正規化によりテキストが変形された」旨の通知を付与 |
| 上記いずれにも該当しない                                    | 安全       | そのまま応答を生成                                                                          |

**URL 差異の付加注釈**: `requested_url` と `fetched_url` が異なる場合 (同一オリジン内のパス差異・HTTPS 昇格・www 変動) は、上記判定にかかわらず応答に「要求した URL とは異なるページのコンテンツが取得された」旨を付加し、両 URL をユーザーに提示する。許容範囲外のオリジン遷移は `pipe-sanitize-gemini.ts` が exit code 1 で fail-closed するため、main agent がこの判定軸で考慮するのは「許容範囲内の遷移が起きたかどうか」のみ。

なお `fetched_url` は Gemini 子の自己申告であり、Gemini が実際にその URL を fetch した完全保証ではない点に留意する (Codex 版と同じ性質)。

## 7. サニタイザの処理層

`sanitize.ts` は `guarded-webfetch-claude` と同等のロジックを持つ独立したコピーとして本スキル内に保持する（異なる LLM 向け skill 間での import / re-export は行わない）。対象は Gemini 子が返した本文テキストであり、以下の 2 層に特化する。

`had_invisible_chars` フラグの正確な意味、`[FILTERED:<カテゴリ>]` / `[ESCAPED:]` の再帰エスケープ順序、grapheme 境界より code unit 境界を優先する根拠 (combining mark スパムによる NFKC / regex の処理コスト跳ね上げ対策) など、設計の詳細は `guarded-webfetch-claude/references/design-plan.md` §7 を参照。ロジックは同等だが、ファイルとしては独立管理する。

### Unicode 層

- NFKC 正規化
- Tag characters の除去
- Zero-width 文字の除去
- LRM / RLM の除去
- Bidi オーバーライドの除去
- 制御文字の除去（タブ・改行を除く）

### LLM マーカー無害化

以下を `[FILTERED:<カテゴリ>]` に置換し、`suspicious_patterns` に記録する。

- `<|im_start|>`, `<|im_end|>`, `<|endoftext|>`
- `<s>`, `<system>`, `<assistant>`, `<user>`, `<untrusted_content>` などの開閉タグ
- `[INST]`, `[/INST]`
- 行頭の `human:`, `assistant:`, `system:`
- `ignore previous instructions`, `new instructions:`, `you are now ...` などの上書きパターン

### 量的制限

- 50,000 文字上限
- truncation は最初に実行し、後続の正規化と走査の処理コスト上限を保証する

## 8. 隔離プロセス仕様

### ランタイム制約

| 項目         | 値                                                          | 制約の強度 |
| ------------ | ----------------------------------------------------------- | ---------- |
| 親コマンド   | `gemini -p`                                                 | ハード     |
| タイムアウト | `timeout 60` (プロセスレベル 60 秒)                         | ハード     |
| sandbox      | `--sandbox` + `GEMINI_SANDBOX=runsc` (runsc 利用可能時のみ) | 条件付き   |
| ツール制限   | `--policy <toml>` で `*` deny + `web_fetch` allow           | ハード     |
| MCP 制限     | policy 内で `mcp_*` を deny                                 | ハード     |
| 出力形式     | `-o json`                                                   | ハード     |
| 出力スキーマ | （CLI 強制無し。プロンプト指示 + 受信側検証）               | ソフト     |
| approval     | `--approval-mode default`                                   | ハード     |
| cwd          | `.temp/guarded-webfetch-gemini/`                            | ハード     |
| 認証         | `GEMINI_API_KEY` 等 whitelist のみ通し、その他 env は scrub | 中         |

### Policy TOML（`quarantine-fetch-policy.toml`）

```toml
# 既定: 全ツール deny。deny は「モデルに見えない」ためツール選択候補から除外される。
# google_web_search や read_file 等の Gemini 標準ツールがモデル inventory に残ると、
# web_fetch deny 時にそれらに逃げて「別経路で目的達成」される (PoC で google_web_search の
# 迂回を確認済み)。よって本ルールは必須。
[[rule]]
toolName = "*"
decision = "deny"
priority = 0

# web_fetch のみ明示 allow。priority を 100 にすることで User tier に存在する
# 一般的な deny rule (priority 0-999) より基本的に優先される。--policy 経由のルールは
# PoC で User tier max priority (999) ですら override できることを確認済み。
[[rule]]
toolName = "web_fetch"
decision = "allow"
priority = 100

# MCP 経由のツールも全 deny。priority 200 は web_fetch allow (100) より高いが、
# mcpName = "*" が指定されているため、MCP 経由でない native web_fetch には
# このルールはマッチしない。MCP 経由で "web_fetch" という名前のツールが
# 提供された場合はこのルールで deny される（意図通り）。
[[rule]]
toolName = "*"
mcpName = "*"
decision = "deny"
priority = 200
```

注意:

- Policy Engine の tier 構造 (公式 docs) は Default(1) / Extension(2) / User(4) / Admin(5) で、final priority = `tier_base + (toml_priority/1000)`
- 公式 docs は `--policy` がどの tier に load されるかを明示していないが、PoC 結果から本スキルの `--policy` 経由ルールは User tier max priority (4.999) すら override する強度を持つことが確認できた (Admin tier 相当の挙動)
- `--admin-policy` も CLI に存在するが、`--policy` で十分なため本スキルでは使用しない
- User tier (`~/.gemini/policies/*.toml`) は本スキルでは触らない（実行ユーザーのカスタム policy を尊重）
- 万が一、本スキルの `--policy` でも override できないユーザー設定が将来現れた場合は、`stats.tools.byName.web_fetch.count === 0` で fail-closed することで安全側に倒す

### Gemini ラッパー (`-o json` の上位 JSON) 構造

PoC で確認した実体スキーマ:

```json
{
  "session_id": "<uuid>",
  "response": "<モデル出力テキスト (本スキルでは内側 JSON 文字列)>",
  "stats": {
    "models": { "<model name>": { "api": {...}, "tokens": {...}, "roles": {...} } },
    "tools": {
      "totalCalls": 1,
      "totalSuccess": 1,
      "totalFail": 0,
      "byName": {
        "web_fetch": { "count": 1, "success": 1, "fail": 0, "durationMs": 3743, ... }
      }
    },
    "files": { "totalLinesAdded": 0, "totalLinesRemoved": 0 }
  },
  "error": "<失敗時のみ>"
}
```

`pipe-sanitize-gemini.ts` は `error` の不在 + `stats.tools.byName.web_fetch.success >= 1` を必須条件として検証する。

### 内側 JSON スキーマ（`fetch-output-schema.json`）

CLI に強制させる手段は無いが、`pipe-sanitize-gemini.ts` が手書きで同等のバリデーションを実装する。具体的には `rejectExtraKeys()` で `additionalProperties: false` 相当の未知フィールド reject、`assertInnerFieldTypes()` で必須 4 フィールドの型検証を行う。外部 schema ライブラリは依存ゼロ方針のため使用しない。`maxLength` 超過はスキーマ違反として reject するのではなく、**parse 後に truncate** してから後続処理に進む（`raw_text` は `sanitize.ts` 内で、`error_message` は `pipe-sanitize-gemini.ts` 内で切り詰め）。これにより Gemini 子が指定文字数を守らなかった場合でも処理が継続される。

```json
{
  "type": "object",
  "required": ["url", "raw_text", "fetch_success", "error_message"],
  "properties": {
    "url": { "type": "string" },
    "raw_text": { "type": "string", "maxLength": 50000 },
    "fetch_success": { "type": "boolean" },
    "error_message": { "type": "string", "maxLength": 500 }
  },
  "additionalProperties": false
}
```

### Exit code 一覧

| Exit code | 意味                                                         | 発生元                       |
| --------- | ------------------------------------------------------------ | ---------------------------- |
| 0         | 正常終了                                                     | —                            |
| 1         | Gemini CLI の一般エラー (レートリミット最終失敗含む)         | `quarantine-fetch-gemini.sh` |
| 2         | URL 入口検証失敗 (スキーム / 禁止文字 / 長さ / private host) | `quarantine-fetch-gemini.sh` |
| 3         | Node.js 23.6 未満                                            | `check-node-version.sh`      |
| 4         | Policy tier 由来の `web_fetch` deny 検出                     | `pipe-sanitize-gemini.ts`    |
| 124       | タイムアウト (60 秒超過)                                     | `timeout` コマンド           |

`pipe-sanitize-gemini.ts` は上記以外の検証失敗 (JSON パースエラー、オリジン不一致、`fetch_success === false` 等) では exit code 1 で終了する。

### `quarantine-fetch-gemini.sh`

このスクリプトは認証情報を whitelist で最低限通しつつ、それ以外の環境変数を `env -i` で完全に消去する。

- **env scrub**: §4「環境変数の取り扱い」で列挙した whitelist のみを `env -i` 経由で渡す。`GEMINI_*` の未知の設定や他社認証情報・親 Claude の env が隔離プロセスに漏れないようにする
- **`--sandbox` + `GEMINI_SANDBOX=runsc` (条件付き)**: スクリプト内で `runsc` バイナリの存在と Docker ランタイムへの登録を確認し、両方が満たされる場合のみ `--sandbox` と `GEMINI_SANDBOX=runsc` を付与する。利用不可の場合は sandbox なしで続行する。ローカル fallback リスク (§10 参照) の主たる緩和は URL 入口検証の private host/IP deny と Policy Engine の `* deny` が担い、sandbox は runsc が利用可能なときに多層防御の一層として上乗せする位置づけ
- **cwd 切替**: `(cd "$quarantine_cwd" && env -i ... gemini ...)` のサブシェルで実行する。`$quarantine_cwd` は `mktemp -d "$PWD/.temp/guarded-webfetch-gemini/run-XXXXXXXX"` で実行ごとに生成し、`trap EXIT` で削除する。隔離 cwd 直下に `GEMINI.md` を置かないことを保証する
- **URL の入口検証**: claude / codex 版と同様、`http://` / `https://` プレフィクス、バッククォート / `$()`、制御文字、長さ上限 (2048 文字) を入口で検証し、不正な URL は `gemini` 起動前に exit code 2 で弾く (API コスト発生前のハード制約)
- **Policy tier 由来の deny 検出**: 本スキルの `--policy` は User tier max priority (999) すら override できることを PoC で確認したため、通常運用ではユーザー側 policy による web_fetch deny は発生しない。万が一それでも web_fetch が呼ばれなかった場合の検出は、`stats.tools.byName.web_fetch.count === 0` で判定し fail-closed する (機械可読シグナル)。stderr 文字列の `Tool "web_fetch" not found.` も補助的に確認可能だが、文字列マッチに依存しない設計を優先する
- **レートリミット時のリトライ**: Gemini CLI v0.40 は内部で自動リトライを実行する (PoC で `Attempt 1 failed: You have exhausted your capacity on this model. Your quota will reset after Xs.. Retrying after Yms...` を観測)。本スキル側での追加リトライは行わない（CLI 内部リトライに委ねる）。最終的に CLI が諦めた場合のみ exit code 1 で終了し main agent に通知する。stderr に `exhausted your capacity` / `rate.?limit` / `429` / `quota` が観測された場合のメッセージ整形は main agent 側で行う
- **タイムアウト**: `timeout 60` でプロセスレベルのハードリミットを設ける。Gemini CLI に `--max-turns` 相当が無いため、無限ループや応答遅延による API コスト暴走を防ぐ。タイムアウト時は exit code 124 で終了し、main agent がユーザーに通知する
- **無害なノイズ stderr の例**: `Warning: 256-color support not detected` / `Ripgrep is not available. Falling back to GrepTool.` などは Gemini CLI の通常出力。stderr マッチで誤検出しないよう、Policy deny / レートリミットの判定は限定的なキーワードに絞る

### `pipe-sanitize-gemini.ts`

- ラッパー JSON のパース（`response`, `stats`, `error`）
- `response` 内の JSON 文字列を再パース
- 失敗時は最初の `{` から最後の `}` の抽出再試行を 1 回だけ行う
- それでも形式不一致なら fail-closed
- それ以外の検証フローは `pipe-sanitize.ts` (Claude 版) / `pipe-sanitize-codex.ts` と同等

## 9. テストケース

最低限確認すべきケース:

1. **正常系**: `https://example.com` を取得し、サニタイズ済み JSON が返る
2. **マーカー検出**: `raw_text` に `<|im_start|>` を含む応答を `pipe-sanitize-gemini.ts` に与え、`[FILTERED:chat_template]` に置換される
3. **error フィールドあり**: Gemini ラッパーで `error` が非 null の場合、fail-closed で終了する
4. **response が JSON でない**: `response` がプレーンテキストや余計な前置きを含む場合、抽出再試行をして 1 回だけ救済し、それでもダメなら fail-closed
5. **fetch_success=false**: 子側で `web_fetch` 失敗を申告した場合、親へ通さずエラー終了する
6. **オリジン不一致**: 要求 URL と取得 URL のオリジンが異なる場合に停止する
7. **ツール横滑り**: prompt で「ファイルを読め」と指示しても policy が `read_file` を deny し、応答に raw_text が無いことを検出してエラー終了する
8. **巨大テキスト**: 50,000 文字超で `truncated: true` が立つ
9. **GEMINI.md 干渉**: 隔離 cwd 配下に `GEMINI.md` が無い前提が崩れた場合に検出（`ls` チェック）
10. **環境チェック**: Node.js 23.6 未満の環境 → 処理を開始せず、`check-node-version.sh` が exit code 3 で終了する
11. **Policy tier deny の検出**: ユーザー側 `~/.gemini/policies/` で `web_fetch` を deny した状態で実行 → `stats.tools.byName.web_fetch.count === 0` (または `web_fetch` キー自体が不在) を `pipe-sanitize-gemini.ts` が検出し、exit code 4 で終了。main agent はユーザーに User tier policy の確認を案内する
12. **`[FILTERED]` / `[ESCAPED:]` 偽装攻撃**: sanitize.ts のテストで `[FILTERED]` / `[ESCAPED:FILTERED]` がそれぞれ `[ESCAPED:FILTERED]` / `[ESCAPED:ESCAPED:FILTERED]` に再帰エスケープされることを確認 (claude 版と共有のため、実体テストは guarded-webfetch-claude 側で実施)
13. **並列処理の部分失敗**: 5 件中 2 件がいずれかの段階で失敗 → 成功した 3 件で応答が生成され、失敗した 2 件がユーザーに報告される
14. **`pipe-sanitize-gemini.ts` のクラッシュ耐性**: 不正な UTF-8 バイト列 (TextDecoder が `U+FFFD` に置換) や極端に長い行を含むテキストを入力した場合 → exit code が非 0 になり、main agent は該当 URL の処理を中止
15. **タイムアウト**: 応答に 60 秒以上かかる場合 → `timeout` により exit code 124 で終了し、main agent がユーザーに通知する
16. **sandbox なしでの動作**: gVisor (runsc) が未インストールの環境 → sandbox なしで正常に fetch が完了し、サニタイズ済み JSON が返る。stderr に sandbox スキップの旨が出力される
17. **error_message 長さ制限**: `error_message` が 500 文字を超える場合 → `pipe-sanitize-gemini.ts` が 500 文字に truncate する

テストは `pipe-sanitize-gemini.ts` の in-source testing (Vitest) と、`quarantine-fetch-gemini.sh` の手動 E2E で行う。

## 10. 設計上の割り切り

- **JSON schema 強制が無い**: Gemini CLI には `--json-schema` 相当が無いため、出力形式の保証はプロンプト指示と受信側バリデーションに依存する。最大の弱点であり、Claude 版より「形式崩し」に弱い
- **Plan Mode は使わない**: Plan Mode + headless では `web_fetch` が deny される。よって `default` モード + Policy で明示 allow にする
- **GEMINI.md の自動読込は cwd 切替で部分的にしか回避できない**: cwd / project レベルの `GEMINI.md` は `mktemp -d` の空ディレクトリ運用で塞げるが、global `~/.gemini/GEMINI.md` は HOME を whitelist している以上 Gemini 子プロセスに読み込まれる。ユーザーが global GEMINI.md に意図せず外部由来の指示を保存していた場合、それが隔離プロセスのシステム指示に注入される経路が残る (公式に GEMINI.md 自動読込を抑止する CLI フラグ / env は v0.40 時点で確認できていない、§13 残課題)
- **`.env` の上方再帰読込 (whitelist バイパスの唯一の既知経路)**: Gemini CLI は cwd から上方再帰で `.env` を探す。`.temp/guarded-webfetch-gemini/run-XXXXXXXX/` に cwd を切り替えても、上位ディレクトリ ($PWD / プロジェクトルート / $HOME) の `.env` がそのまま拾われる可能性がある。`HOME` を whitelist で渡しているため `~/.gemini/.env` も読まれうる。**これは `env -i` による whitelist 方式を迂回する唯一の既知経路であり**、`.env` 内に `GEMINI_SANDBOX` や将来追加される `GEMINI_*` 系の env が含まれていた場合、本スキルが `env -i` で消去した変数が `.env` 経由で復活する。`.env` には認証情報が入っている前提で、本スキルではこの読込経路をブロックしない (§13 残課題: `GEMINI_CLI_NO_DOTENV` 等の抑止フラグが将来追加されたら採用)
- **Workspace trust は `--skip-trust` で bypass する**: trust チェックをスキップする以上、`gemini -p` が cwd 内のファイルを誤って実行する経路を CLI 側で抑止する保険が外れる。本スキルでは `mktemp -d` で空ディレクトリの cwd に切り替えていることと policy の `* deny` でこのリスクを抑える
- **認証情報の通過は whitelist 方式**: §4 で列挙した `GEMINI_API_KEY` / `GOOGLE_APPLICATION_CREDENTIALS` 等のみを `env -i` 経由で通す。安全性と認証経路の両立のためのトレードオフ
- **ローカル fallback の挙動 (PoC E で検証済み)**: Gemini API の `urlContext` 失敗時にローカルマシンから raw 取得する仕様は実在する。主たる緩和層は URL 入口検証の private host/IP deny と Policy Engine の `* deny`。runsc が利用可能な環境ではこれに加えて `--sandbox` + `GEMINI_SANDBOX=runsc` の OS レベル隔離を多層防御の一層として上乗せする。runsc が利用不可の場合は sandbox 層を持たずに動作する。PoC 結果は以下の通り (PoC は Docker sandbox で実施。gVisor sandbox でも同等以上の隔離が期待できる):
  - `localhost` / `127.0.0.1` / `0.0.0.0` / `[::1]` (IPv6 loopback): Gemini WebFetchTool 自体に「private or local host」スキップ機構があり、sandbox の有無に依らずスキップされる (`[WebFetchTool] Skipped private or local host: ...`)
  - sandbox 無しでの fallback: host のディレクトリ全体に到達可能 (PoC E-1 で host:8080 listener の dir listing から関連ファイル群を取得されることを確認)
  - sandbox 有り (`--sandbox docker`) の fallback: container 内に閉じ込められ、host へは到達しない (PoC E-2 で container 内 ECONNREFUSED を確認)
  - **`host.docker.internal`**: WebFetchTool のスキップ対象外。`--sandbox docker` 起動時に `--add-host=host.docker.internal:host-gateway` 相当が付与されるため、container から host gateway 経由で host サービスに到達してしまう (PoC E-4 で確認、host listener にアクセスログが残る)
  - `file://`: WebFetchTool 自体が "Only http and https are supported" で拒否 (PoC E-3 で確認)
- **`host.docker.internal` 経路は本スキル側で URL 入口検証で塞ぐ**: PoC E-4 の漏洩経路を防ぐため、`pipe-sanitize-gemini.ts` の `validateCliUrl` で次のホスト名・IP 範囲を完全 deny する。`quarantine-fetch-gemini.sh` 側は典型ケース (`localhost` 等の代表ホスト名・IPv4 private 範囲・IPv6 `::1`) のみを早期に弾く簡易チェックに留め、完全な検証 (末尾ドット, IPv4-mapped IPv6, IPv6 ULA / link-local, user info 込みのホスト抽出など) は TS 側に集約する:
  - ホスト名: `localhost`, `localhost.localdomain`, `host.docker.internal`, `host.containers.internal`, `gateway.docker.internal`, `gateway.containers.internal`, `host-gateway` および末尾ドット表記
  - IP リテラル: `127.0.0.0/8`, `0.0.0.0`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (link-local), `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped IPv6 (`::ffff:x.x.x.x` 混在表記および `::ffff:7f00:1` 完全展開形)
  - 二層化の割り切り: shell の簡易チェックを TS と完全一致させると IPv4-mapped IPv6 の hex 進数変換等の二重実装になり保守負担が増える。shell では「明らかな private host を API コスト発生前に弾く」までを担当し、完全な fail-closed は TS 側で行う設計とした
  - これは「ホスト名で書かれた URL が DNS で private IP に解決される」攻撃 (DNS rebinding 等) までは防げない (best-effort)。完全防御にはならないが、典型的な漏洩パターンは塞ぐ
- **sandbox は runsc 利用可能時にリスク軽減のため有効化する**: ローカル fallback リスクの主たる緩和は URL 入口検証の private host/IP deny (§10「`host.docker.internal` 経路」参照) と Policy Engine の `* deny` が担う。runsc が利用可能な環境では `GEMINI_SANDBOX=runsc` + `--sandbox` で OS レベル隔離を多層防御の一層として上乗せする。利用不可の場合は sandbox 層を持たずに続行する。完全遮断にはならないが、DNS rebinding 等の高度な攻撃以外の典型的な漏洩パターンは塞ぐ
- **隔離プロセスの stderr が main agent に流れる経路は残る**: `quarantine-fetch-gemini.sh` は失敗時に Gemini 子の stderr を親に流す。通常は CLI 自体のエラー文だが、ランタイム仕様変更や巧妙な入力で stderr 側に攻撃ペイロードが現れる可能性は完全には排除できない (claude 版と同じ性質)
- **依存ゼロ**: Node 標準のみで完結させ、配布性を最大化する (`pipe-sanitize-gemini.ts` も含めて外部パッケージなし)
- **フォールバックなし**: Node 23.6 未満は fail-fast。複数の実行経路を持つと保守性が落ちる
- **URL のシェルインジェクション防止は多層**: main agent → `quarantine-fetch-gemini.sh` の呼び出しで URL を `'...'` で囲むのは main agent のソフト判断。`quarantine-fetch-gemini.sh` の入口でスキーム検証 (`http://` / `https://` のみ) ・禁止文字検証 (バッククォート / `$()` / 制御文字) ・長さ上限 (2048 文字) を行い、不正な URL は API コスト発生前にハード制約として弾く。`pipe-sanitize-gemini.ts` 側の `validateCliUrl` は深層防御として残し、private host / 末尾ドット / IPv4-mapped IPv6 / user info を含むホスト抽出など shell では扱わない検証を担当する
- **ローカルファイルの出所追跡は不可**: 外部由来のファイルがローカル保存される経路を自動追跡する仕組みはなく、main agent のソフト判断に依存する
- **LLM マーカーの過検出**: `<s>` / `</s>` は Llama BOS/EOS と HTML strikethrough の衝突、`you are now ` / `new instructions:` は通常英文との衝突がありうる。「過検出寄りで fail-closed、ユーザー確認で運用補完」の方針を採用 (claude 版と共通)
- **パターンリストの陳腐化**: LLM マーカーのパターンは新しい攻撃手法の出現により陳腐化する。`guarded-webfetch-claude/references/injection_patterns.md` の更新に追従し、本スキルの `sanitize.ts` にも反映する
- **完全防御ではない**: 要確認時に親 Claude が出力を抑制する運用が前提

## 11. 既存スキルとの比較

guarded-\*-claude / guarded-\*-codex / guarded-\*-gemini の防御実装の差異（子コマンド・出力スキーマ強制・ツール固定方式・Sandbox・MCP 制限・Memory 自動読込抑止・ローカル fallback リスク・認証など）はリポジトリ README の「子プロセスごとの防御実装の比較」表を Single Source of Truth とする。本スキルが Gemini 固有に必要とする多層防御（URL 入口検証・Policy Engine・gVisor sandbox・受信側スキーマ検証）の背景は §10 の割り切りと §8 の Policy / スキーマ仕様を併せて参照。

## 12. 将来的な拡張候補

- **Gemini の構造化出力対応**: 将来 CLI で `--json-schema` 相当が追加されたら採用し、出力スキーマ強度を Claude 並みに引き上げる
- **`--policy` の Workspace tier 復活**: 現在 disabled の Workspace tier が復活したら `.gemini/policies/` 配下に置いて `--policy` 引数を省略する形に移行できる
- **guarded-websearch-gemini**: Web 検索結果一覧向けに同じ構造を展開する
- **二段隔離**: Gemini 子を取得専用、別プロセスを要約専用に分離する
- **Sandbox バックエンドの選択肢拡充**: 現在は runsc のみをサポートしているが、Docker / Podman への切替オプションを追加し、sandbox 利用率を向上させる

## 13. 残課題と未確定事項

調査・検証は Gemini CLI v0.40.0 / Google アカウント OAuth ログイン環境で実施。実装完了後も継続的に観察・追従が必要な項目を以下に列挙する。

- [ ] **GEMINI.md 自動読込を抑止する公式手段** — global `~/.gemini/GEMINI.md` の読込抑止フラグ / env / `settings.json` キーが v0.40 にあるか調査。見つからなければ §10 の割り切りとして恒久化
- [ ] **`.env` 上方再帰読込の抑止 (whitelist バイパスの唯一の既知経路)** — `env -i` で消去した変数が `.env` 経由で復活しうるため、`GEMINI_CLI_NO_DOTENV` 等の抑止フラグの有無を確認する。`.env` 内に `GEMINI_SANDBOX` 等が含まれていた場合、本スキルの sandbox 設定が上書きされるリスクがある。見つからなければ §10 の割り切りとして恒久化し、`.env` に security-sensitive な `GEMINI_*` を含めないよう運用ガイドに記載する
- [ ] **`--policy` が Admin tier 相当に振る舞う根拠** — 公式 docs の tier 表 (Default=1 / Extension=2 / User=4 / Admin=5) からは User tier max (4.999) を上書きできる説明がつかない。CLI ソース読みかさらなる PoC で根拠を確認し、将来のバージョンアップで挙動が変わるリスクに備える
- [ ] **トークン消費見積もりとレートリミット試算** — "pong" 1 語で input 7,784 tokens、web_fetch 1 回で 17K+ tokens。並列 5 件運用時のコスト試算、OAuth 無料枠 / API key 有料枠でのレートリミット観察を継続
- [ ] **DNS rebinding への対応** — §10 の private host deny は名前ベースのフィルタで、ホスト名が DNS で private IP に解決されるケースは防げない。Gemini CLI の WebFetchTool 自身もホスト名解決後の IP までチェックしているとは限らないため、必要に応じて将来 `pipe-sanitize-gemini.ts` 側で DNS 解決後の IP を二段検証するなどの強化を検討
- [ ] **デフォルトモデルの stable 後継追従** — 現在 `scripts/quarantine-fetch-gemini.sh` で `gemini-3.1-flash-lite-preview` を `-m` で明示固定しているが preview ラベル付きであり、品質・互換性・料金が変動しうる。preview ラベルが外れた stable 後継、または同系統の安定モデルが出たら差し替える

## 14. 参考資料

- [`guarded-webfetch-claude/references/design-plan.md`](../../guarded-webfetch-claude/references/design-plan.md)
- [`guarded-webfetch-codex/references/design-plan.md`](../../guarded-webfetch-codex/references/design-plan.md)
- Gemini CLI 公式リポジトリ — <https://github.com/google-gemini/gemini-cli>
- Gemini CLI 公式ドキュメント (リポジトリ owner 管理)
  - Headless mode — <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md>
  - Policy Engine — <https://github.com/google-gemini/gemini-cli/blob/main/docs/core/policy-engine.md>
  - Sandbox — <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md>
  - `web_fetch` tool — <https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/web-fetch.md>
  - Commands reference — <https://github.com/google-gemini/gemini-cli/tree/main/docs/reference/commands>
  - 各ファイルパスはリポジトリの実態に合わせて要再確認 (リポジトリ構造変更時の追随が必要)
- AWS "Defending LLM applications against Unicode character smuggling"
- Promptfoo "The Invisible Threat: Zero-Width Unicode Characters"
