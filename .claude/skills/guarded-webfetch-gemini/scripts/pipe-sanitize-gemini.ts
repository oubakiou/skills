/**
 * Gemini CLI の -o json 出力を stdin から読み、sanitize して stdout に出力するパイプスクリプト。
 * 隔離プロセス (gemini -p) の出力をパイプで受け取り、生テキストが main agent に入ることを防ぐ。
 * @example gemini -p ... -o json "prompt" | node pipe-sanitize-gemini.ts "<url>"
 */

import { realpathSync } from 'node:fs'

import { sanitize } from './sanitize.ts'

// ---------- Private host / IP deny リスト ----------

/** PoC E-4 で host.docker.internal が sandbox 漏洩経路になることを確認。典型的な private ホスト名を deny する */
const DENIED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'host.docker.internal',
  'host.containers.internal',
  'gateway.docker.internal',
  'gateway.containers.internal',
  'host-gateway',
])

/** IPv4 の先頭オクテットに基づく private 範囲判定テーブル */
const IPV4_FIRST_OCTET_PRIVATE = new Set([127, 0, 10])

/**
 * IPv4 の先頭 2 オクテットに基づく private 範囲判定。
 * 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 をカバーする。
 */
const isPrivateBySecondOctet = (first: number, second: number): boolean => {
  if (first === 172 && second >= 16 && second <= 31) {
    return true
  }
  if (first === 192 && second === 168) {
    return true
  }
  if (first === 169 && second === 254) {
    return true
  }
  return false
}

/**
 * IPv4 アドレスが private / loopback / link-local 範囲に含まれるか判定する。
 * 127.0.0.0/8, 0.0.0.0, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16
 */
const isPrivateIpv4 = (hostname: string): boolean => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!match) {
    return false
  }
  const octets = match.slice(1).map(Number)
  const [first, second] = octets
  if (IPV4_FIRST_OCTET_PRIVATE.has(first)) {
    return true
  }
  return isPrivateBySecondOctet(first, second)
}

/** IPv6 の bracket を除去する */
const stripIpv6Brackets = (hostname: string): string => {
  if (hostname.startsWith('[')) {
    return hostname.slice(1, -1)
  }
  return hostname
}

/** 16bit 値を上位・下位オクテットに分解して "a.b" 形式にする (ビット演算を避ける) */
const hexWordToOctets = (word: number): string => {
  const hi = Math.floor(word / 256)
  const lo = word % 256
  return `${hi}.${lo}`
}

/**
 * IPv4-mapped IPv6 (::ffff:x.x.x.x) から内側の IPv4 部分を抽出する。
 * new URL() は ::ffff:127.0.0.1 を [::ffff:7f00:1] のように正規化するため、
 * 完全展開形 (::ffff:7f00:1) と混在表記 (::ffff:127.0.0.1) の両方に対応する。
 */
const extractMappedIpv4 = (ipv6: string): string | null => {
  // 混在表記: ::ffff:127.0.0.1
  const mixedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ipv6)
  if (mixedMatch) {
    return mixedMatch[1]
  }
  // 完全展開形: ::ffff:7f00:1 → 上位16bit:下位16bit を IPv4 に変換
  const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ipv6)
  if (hexMatch) {
    return `${hexWordToOctets(Number.parseInt(hexMatch[1], 16))}.${hexWordToOctets(Number.parseInt(hexMatch[2], 16))}`
  }
  return null
}

/** IPv4-mapped IPv6 の内側 IPv4 が private かを判定する */
const isPrivateMappedIpv4 = (ipv6Lower: string): boolean => {
  const mapped = extractMappedIpv4(ipv6Lower)
  return mapped !== null && isPrivateIpv4(mapped)
}

/** IPv6 アドレスが private / loopback / link-local 範囲に含まれるか判定する */
const isPrivateIpv6 = (hostname: string): boolean => {
  const lower = stripIpv6Brackets(hostname).toLowerCase()
  if (lower === '::1') {
    return true
  } // loopback
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    return true
  } // fc00::/7 (ULA)
  if (lower.startsWith('fe80')) {
    return true
  } // fe80::/10 (link-local)
  return isPrivateMappedIpv4(lower)
}

/** FQDN 末尾のドットを除去する (localhost. → localhost) */
const stripTrailingDot = (hostname: string): string => hostname.replace(/\.$/, '')

/** ホスト名が private / loopback / link-local に該当するか判定する */
const isPrivateHost = (hostname: string): boolean => {
  const lower = stripTrailingDot(hostname.toLowerCase())
  if (DENIED_HOSTNAMES.has(lower)) {
    return true
  }
  if (isPrivateIpv4(lower)) {
    return true
  }
  if (isPrivateIpv6(lower)) {
    return true
  }
  return false
}

// ---------- URL バリデーション ----------

/** URL 文字列をパースする。失敗時はエラーを投げる */
const parseUrl = (url: string): URL => {
  try {
    return new URL(url)
  } catch {
    throw new Error(`URL のパースに失敗しました: ${url}`)
  }
}

/** 要求 URL と取得 URL の両方をパースする。失敗時は両方の URL を含むエラーを投げる */
const parseUrlPair = (
  requestedUrl: string,
  fetchedUrl: string
): { fetched: URL; requested: URL } => {
  try {
    return { fetched: new URL(fetchedUrl), requested: new URL(requestedUrl) }
  } catch {
    throw new Error(
      `URL のオリジン比較に失敗しました (requested: ${requestedUrl}, fetched: ${fetchedUrl})`
    )
  }
}

/**
 * CLI 引数の URL を検証する。http: または https: のみ許可し、private host を拒否する。
 * @throws 不正なプロトコル、private host、またはパース失敗時
 */
export const validateCliUrl = (url: string): void => {
  const parsed = parseUrl(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `URL のプロトコルが不正です (${parsed.protocol}). http: または https: のみ許可されます`
    )
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error(
      `URL のホストが private/loopback 範囲です (${parsed.hostname}). セキュリティ上の理由により拒否されました`
    )
  }
}

/** ホスト名から先頭の `www.` プレフィクスを除去する */
const stripWwwPrefix = (hostname: string): string => hostname.replace(/^www\./i, '')

/**
 * 要求 URL → 取得 URL の遷移が許容範囲かを判定する。
 *
 * 許容ケース（実運用で頻発する正規リダイレクト）:
 * - 完全一致
 * - HTTPS 昇格: http → https（同一ホスト・同一ポート）
 * - www. プレフィクスの有無の差: example.com <-> www.example.com（同一スキーム・同一ポート）
 * - 上記の組み合わせ
 *
 * 拒否ケース（fail-closed の対象）:
 * - HTTPS から HTTP への降格
 * - クロスオリジンへの遷移（CDN/別ホストなど）
 * - ポート変更
 */
const isAllowedOriginTransition = (requested: URL, fetched: URL): boolean => {
  const schemeOk =
    requested.protocol === fetched.protocol ||
    (requested.protocol === 'http:' && fetched.protocol === 'https:')
  const hostOk = stripWwwPrefix(requested.hostname) === stripWwwPrefix(fetched.hostname)
  const portOk = requested.port === fetched.port
  return schemeOk && hostOk && portOk
}

/**
 * 要求 URL と隔離プロセスが返した URL の遷移が許容範囲か検証する。
 * 取得 URL が private host の場合も拒否する。
 * 不許可の場合はエラーを投げる（fail-closed）。
 */
export const validateUrlOriginMatch = (requestedUrl: string, fetchedUrl: string): void => {
  const { requested, fetched } = parseUrlPair(requestedUrl, fetchedUrl)
  if (isPrivateHost(fetched.hostname)) {
    throw new Error(
      `隔離プロセスが private/loopback ホストへ遷移しました (fetched: ${fetched.hostname}). セキュリティ上の理由により処理を中止します`
    )
  }
  if (!isAllowedOriginTransition(requested, fetched)) {
    throw new Error(
      `隔離プロセスが許容範囲外のオリジンへ遷移しました (requested: ${requested.origin}, fetched: ${fetched.origin}). コンテンツの出所が要求と一致しないため処理を中止します`
    )
  }
}

// ---------- Gemini ラッパー JSON 処理 ----------

/** Policy tier 由来の web_fetch deny を表すエラー。exit code 4 で終了する */
class WebFetchDenyError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'WebFetchDenyError'
  }
}

/** 値がオブジェクトかどうか判定する型ガード */
const isRecord = (val: unknown): val is Record<string, unknown> =>
  typeof val === 'object' && val !== null && !Array.isArray(val)

/** JSON パース。失敗時はカスタムメッセージでエラーを投げる */
const parseJsonStrict = (text: string, errorMessage: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(errorMessage)
  }
}

/** error_message が maxLength (500) を超える場合に truncate する */
const truncateErrorMessage = (msg: string): string => {
  const MAX_ERROR_LENGTH = 500
  if (msg.length <= MAX_ERROR_LENGTH) {
    return msg
  }
  return msg.slice(0, MAX_ERROR_LENGTH)
}

/** ネストされた Record を掘り下げる。途中が非 Record なら WebFetchDenyError を投げる */
const drillRecord = (
  obj: Record<string, unknown>,
  key: string,
  path: string
): Record<string, unknown> => {
  const val = obj[key]
  if (!isRecord(val)) {
    throw new WebFetchDenyError(`${path} フィールドがオブジェクトではありません`)
  }
  return val
}

/** stats から web_fetch の統計情報を掘り下げて返す。不正な場合は WebFetchDenyError を投げる */
const extractWebFetchStats = (stats: unknown): Record<string, unknown> => {
  if (!isRecord(stats)) {
    throw new WebFetchDenyError('stats フィールドがオブジェクトではありません')
  }
  const tools = drillRecord(stats, 'tools', 'stats.tools')
  const byName = drillRecord(tools, 'byName', 'stats.tools.byName')
  const webFetch = byName.web_fetch
  if (!isRecord(webFetch)) {
    throw new WebFetchDenyError(
      'stats.tools.byName.web_fetch が存在しないか不正です。Policy tier により web_fetch が deny されている可能性があります'
    )
  }
  return webFetch
}

/**
 * Gemini ラッパー JSON の stats.tools.byName.web_fetch を検証する。
 * web_fetch が一度も呼ばれていない場合は Policy tier 由来の deny と判断する。
 */
const validateWebFetchStats = (stats: unknown): void => {
  const webFetch = extractWebFetchStats(stats)
  const { count } = webFetch
  if (typeof count !== 'number' || count === 0) {
    throw new WebFetchDenyError(
      'web_fetch の呼び出し回数が 0 です。Policy tier により web_fetch が deny されている可能性があります'
    )
  }
  const { success } = webFetch
  if (typeof success !== 'number' || success === 0) {
    throw new Error('web_fetch の成功回数が 0 です。すべての web_fetch 呼び出しが失敗しました')
  }
}

/**
 * response 文字列から JSON オブジェクトを抽出する。
 * 直接 parse を試み、失敗した場合は最初の { から最後の } までを抽出して再試行する。
 */
const extractJsonFromResponse = (response: string): unknown => {
  // 直接パースを試みる
  try {
    return JSON.parse(response) as unknown
  } catch {
    // フォールバック: 最初の { から最後の } までを抽出して再パース
    const firstBrace = response.indexOf('{')
    const lastBrace = response.lastIndexOf('}')
    if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
      throw new Error(
        'Gemini の response が JSON ではなく、JSON オブジェクトの抽出にも失敗しました'
      )
    }
    const extracted = response.slice(firstBrace, lastBrace + 1)
    return parseJsonStrict(
      extracted,
      'Gemini の response から抽出した文字列も有効な JSON ではありません'
    )
  }
}

/** Gemini error フィールドの文字列表現を取得する */
const formatGeminiError = (error: unknown): string => {
  if (typeof error === 'string') {
    return error
  }
  return JSON.stringify(error)
}

/** fetch 失敗時の error_message を整形する */
const formatFetchErrorMessage = (errorMessage: unknown): string => {
  if (typeof errorMessage === 'string') {
    return truncateErrorMessage(errorMessage)
  }
  return '不明なエラー'
}

/** fetch-output-schema.json の required フィールド。additionalProperties: false を手書きで強制する */
const ALLOWED_INNER_KEYS = new Set(['url', 'raw_text', 'fetch_success', 'error_message'])

/** additionalProperties: false — 未知フィールドを reject する (fetch-output-schema.json 相当) */
const rejectExtraKeys = (inner: Record<string, unknown>): void => {
  const extraKeys = Object.keys(inner).filter((key) => !ALLOWED_INNER_KEYS.has(key))
  if (extraKeys.length > 0) {
    throw new Error(`Gemini 出力に未知のフィールドが含まれています: ${extraKeys.join(', ')}`)
  }
}

/** 必須フィールドの型を検証し、型安全な値を返す (fetch-output-schema.json の type 制約に相当) */
const assertInnerFieldTypes = (
  inner: Record<string, unknown>
): { fetchSuccess: boolean; rawText: string; url: string } => {
  if (typeof inner.url !== 'string') {
    throw new Error('Gemini 出力の url が文字列ではありません')
  }
  if (typeof inner.raw_text !== 'string') {
    throw new Error('Gemini 出力の raw_text が文字列ではありません')
  }
  if (typeof inner.fetch_success !== 'boolean') {
    throw new Error('Gemini 出力の fetch_success が boolean ではありません')
  }
  return { fetchSuccess: inner.fetch_success, rawText: inner.raw_text, url: inner.url }
}

/** 内側 JSON のフィールドを検証して fetch 結果を返す (fetch-output-schema.json 相当) */
const validateInnerFields = (inner: Record<string, unknown>): { rawText: string; url: string } => {
  rejectExtraKeys(inner)
  const { fetchSuccess, rawText, url } = assertInnerFieldTypes(inner)
  if (!fetchSuccess) {
    const errorMessage = formatFetchErrorMessage(inner.error_message)
    throw new Error(`Gemini の web_fetch が失敗しました: ${errorMessage}`)
  }
  return { rawText, url }
}

/** Gemini ラッパーの envelope (error / response / stats) を検証する */
const validateEnvelope = (data: Record<string, unknown>): string => {
  // error フィールドが存在すれば fail-closed
  if ('error' in data && data.error !== null) {
    throw new Error(`Gemini CLI がエラーを返しました: ${formatGeminiError(data.error)}`)
  }
  if (typeof data.response !== 'string') {
    throw new Error('Gemini ラッパーの response フィールドが文字列ではありません')
  }
  validateWebFetchStats(data.stats)
  return data.response
}

/**
 * Gemini の -o json ラッパーを検証し、response 内の fetch 結果を抽出する。
 * ラッパー形式: { session_id, response, stats, error? }
 */
export const extractRawText = (data: unknown): { rawText: string; url: string } => {
  if (!isRecord(data)) {
    throw new Error('入力が JSON オブジェクトではありません')
  }
  const response = validateEnvelope(data)
  const inner = extractJsonFromResponse(response)
  if (!isRecord(inner)) {
    throw new Error('Gemini の response 内の JSON がオブジェクトではありません')
  }
  return validateInnerFields(inner)
}

// ---------- stdin 読み取り ----------

/**
 * 隔離プロセスの stdout バイト上限。50,000 字 raw_text (UTF-8 で最大 200KB) +
 * Gemini の -o json ラッパー (stats 等) を含めても通常 1MB を大きく超えないため、
 * 2MB を超えた時点で異常 (子の暴走 / 攻撃的応答) と見なして fail-closed する。
 */
export const MAX_STDIN_BYTES = 2_000_000

/** stdin を全て読み取り、UTF-8 文字列にトリムして返す。バイト上限を超えたら fail-closed */
export const readStdinTrim = async (
  source: AsyncIterable<Uint8Array> = process.stdin,
  maxBytes: number = MAX_STDIN_BYTES
): Promise<string> => {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of source) {
    const buffer = Buffer.from(chunk)
    totalBytes += buffer.length
    if (totalBytes > maxBytes) {
      throw new Error(`stdin が上限を超えました (${totalBytes} > ${maxBytes} bytes)`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

// ---------- CLI ----------

const isEntryFile = (): boolean => {
  const [, entryPath] = process.argv
  if (!entryPath) {
    return false
  }
  return import.meta.url === `file://${realpathSync(entryPath)}`
}

const formatThrown = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

const writeJsonOutput = (value: unknown): void => {
  const INDENT = 2
  const json = JSON.stringify(value, null, INDENT)
  process.stdout.write(`${json}\n`)
}

/** stdin から JSON を読み、Gemini ラッパーを検証して raw_text を取り出す */
const readEnvelope = async (): Promise<{ rawText: string; url: string }> => {
  const raw = await readStdinTrim()
  if (!raw) {
    throw new Error('stdin が空です')
  }
  const data = parseJsonStrict(raw, 'Gemini ラッパーの JSON パースに失敗しました')
  return extractRawText(data)
}

const runCli = async (): Promise<void> => {
  const [cliUrl] = process.argv.slice(2)
  if (!cliUrl) {
    throw new Error(
      'CLI 引数として要求 URL が必須です（オリジン検証スキップを防ぐための fail-closed 設計）'
    )
  }
  validateCliUrl(cliUrl)
  const { url: fetchedUrl, rawText } = await readEnvelope()
  // オリジン不一致は fail-closed（隔離プロセスが別サイトを fetch した可能性）
  validateUrlOriginMatch(cliUrl, fetchedUrl)
  const result = sanitize(cliUrl, fetchedUrl, rawText)
  writeJsonOutput(result)
}

/** exit code を決定する */
const getExitCode = (error: unknown): number => {
  if (error instanceof WebFetchDenyError) {
    return 4
  }
  return 1
}

if (isEntryFile()) {
  try {
    await runCli()
  } catch (error) {
    process.stderr.write(`ERROR: ${formatThrown(error)}\n`)
    process.exitCode = getExitCode(error)
  }
}

// ---------- In-Source Testing ----------

const yieldChunks = async function* yieldChunks(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk
  }
}

/** テスト用: 正常な Gemini ラッパー JSON を構築する */
const buildGeminiWrapper = (
  response: Record<string, unknown>,
  overrides?: {
    error?: string
    stats?: unknown
  }
): unknown => {
  const defaultStats = {
    files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
    models: {},
    tools: {
      byName: {
        web_fetch: { count: 1, durationMs: 1000, fail: 0, success: 1 },
      },
      totalCalls: 1,
      totalFail: 0,
      totalSuccess: 1,
    },
  }
  let stats: unknown = defaultStats
  if (overrides && 'stats' in overrides) {
    ;({ stats } = overrides)
  }
  const base: Record<string, unknown> = {
    response: JSON.stringify(response),
    session_id: 'test-session-id',
    stats,
  }
  if (overrides && 'error' in overrides) {
    base.error = overrides.error
  }
  return base
}

/**
 * MARK: In-Source Testing
 * @example vp test .claude/skills/guarded-webfetch-gemini/scripts/pipe-sanitize-gemini.ts
 */

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest

  describe('isPrivateHost', () => {
    describe('denied ホスト名', () => {
      it('localhost を拒否する', () => {
        expect(isPrivateHost('localhost')).toBe(true)
      })

      it('host.docker.internal を拒否する', () => {
        expect(isPrivateHost('host.docker.internal')).toBe(true)
      })

      it('host.containers.internal を拒否する', () => {
        expect(isPrivateHost('host.containers.internal')).toBe(true)
      })

      it('gateway.docker.internal を拒否する', () => {
        expect(isPrivateHost('gateway.docker.internal')).toBe(true)
      })

      it('host-gateway を拒否する', () => {
        expect(isPrivateHost('host-gateway')).toBe(true)
      })

      it('大文字小文字を区別しない', () => {
        expect(isPrivateHost('LOCALHOST')).toBe(true)
        expect(isPrivateHost('Host.Docker.Internal')).toBe(true)
      })
    })

    describe('private IPv4 (loopback / zero)', () => {
      it('127.0.0.1 を拒否する', () => {
        expect(isPrivateIpv4('127.0.0.1')).toBe(true)
      })

      it('127.255.255.255 を拒否する', () => {
        expect(isPrivateIpv4('127.255.255.255')).toBe(true)
      })

      it('0.0.0.0 を拒否する', () => {
        expect(isPrivateIpv4('0.0.0.0')).toBe(true)
      })

      it('10.0.0.1 を拒否する', () => {
        expect(isPrivateIpv4('10.0.0.1')).toBe(true)
      })
    })

    describe('private IPv4 (second octet ranges)', () => {
      it('172.16.0.1 を拒否する', () => {
        expect(isPrivateIpv4('172.16.0.1')).toBe(true)
      })

      it('172.31.255.255 を拒否する', () => {
        expect(isPrivateIpv4('172.31.255.255')).toBe(true)
      })

      it('172.15.0.1 を許可する', () => {
        expect(isPrivateIpv4('172.15.0.1')).toBe(false)
      })

      it('172.32.0.1 を許可する', () => {
        expect(isPrivateIpv4('172.32.0.1')).toBe(false)
      })

      it('192.168.1.1 を拒否する', () => {
        expect(isPrivateIpv4('192.168.1.1')).toBe(true)
      })

      it('169.254.1.1 を拒否する (link-local)', () => {
        expect(isPrivateIpv4('169.254.1.1')).toBe(true)
      })
    })

    describe('public IPv4', () => {
      it('8.8.8.8 を許可する', () => {
        expect(isPrivateIpv4('8.8.8.8')).toBe(false)
      })

      it('93.184.216.34 を許可する', () => {
        expect(isPrivateIpv4('93.184.216.34')).toBe(false)
      })
    })

    describe('private IPv6', () => {
      it('::1 を拒否する', () => {
        expect(isPrivateIpv6('::1')).toBe(true)
        expect(isPrivateIpv6('[::1]')).toBe(true)
      })

      it('fc00:: を拒否する (ULA)', () => {
        expect(isPrivateIpv6('fc00::1')).toBe(true)
      })

      it('fd00:: を拒否する (ULA)', () => {
        expect(isPrivateIpv6('fd12::1')).toBe(true)
      })

      it('fe80:: を拒否する (link-local)', () => {
        expect(isPrivateIpv6('fe80::1')).toBe(true)
      })

      it('2001:db8::1 を許可する', () => {
        expect(isPrivateIpv6('2001:db8::1')).toBe(false)
      })
    })

    describe('FQDN 末尾ドット (表記ゆれバイパス対策)', () => {
      it('localhost. (末尾ドット) を拒否する', () => {
        expect(isPrivateHost('localhost.')).toBe(true)
      })

      it('host.docker.internal. (末尾ドット) を拒否する', () => {
        expect(isPrivateHost('host.docker.internal.')).toBe(true)
      })
    })

    describe('localhost.localdomain', () => {
      it('localhost.localdomain を拒否する', () => {
        expect(isPrivateHost('localhost.localdomain')).toBe(true)
      })
    })

    describe('IPv4-mapped IPv6 (::ffff:x.x.x.x バイパス対策)', () => {
      it('[::ffff:7f00:1] (127.0.0.1 の正規化形) を拒否する', () => {
        expect(isPrivateIpv6('[::ffff:7f00:1]')).toBe(true)
      })

      it('::ffff:127.0.0.1 (混在表記) を拒否する', () => {
        expect(isPrivateIpv6('::ffff:127.0.0.1')).toBe(true)
      })

      it('::ffff:a00:1 (10.0.0.1 の正規化形) を拒否する', () => {
        expect(isPrivateIpv6('::ffff:a00:1')).toBe(true)
      })

      it('::ffff:c0a8:101 (192.168.1.1 の正規化形) を拒否する', () => {
        expect(isPrivateIpv6('::ffff:c0a8:101')).toBe(true)
      })

      it('::ffff:8.8.8.8 (public) を許可する', () => {
        expect(isPrivateIpv6('::ffff:8.8.8.8')).toBe(false)
      })

      it('[::ffff:808:808] (8.8.8.8 の正規化形) を許可する', () => {
        expect(isPrivateIpv6('[::ffff:808:808]')).toBe(false)
      })
    })

    describe('public ホスト', () => {
      it('example.com を許可する', () => {
        expect(isPrivateHost('example.com')).toBe(false)
      })

      it('google.com を許可する', () => {
        expect(isPrivateHost('google.com')).toBe(false)
      })
    })
  })

  describe('validateCliUrl', () => {
    describe('プロトコル検証', () => {
      it('https URL を許可する', () => {
        expect(() => validateCliUrl('https://example.com')).not.toThrow()
      })

      it('http URL を許可する', () => {
        expect(() => validateCliUrl('http://example.com')).not.toThrow()
      })

      it('ftp URL を拒否する', () => {
        expect(() => validateCliUrl('ftp://example.com')).toThrow('プロトコルが不正')
      })

      it('file URL を拒否する', () => {
        expect(() => validateCliUrl('file:///etc/passwd')).toThrow('プロトコルが不正')
      })

      it('javascript スキームの URL を拒否する', () => {
        const scheme = 'javascript'
        expect(() => validateCliUrl(`${scheme}:alert(1)`)).toThrow('プロトコルが不正')
      })

      it('不正な文字列を拒否する', () => {
        expect(() => validateCliUrl('not-a-url')).toThrow('パースに失敗')
      })

      it('空文字を拒否する', () => {
        expect(() => validateCliUrl('')).toThrow('パースに失敗')
      })
    })

    describe('private host 検証', () => {
      it('localhost URL を拒否する', () => {
        expect(() => validateCliUrl('http://localhost:8080')).toThrow('private/loopback')
      })

      it('127.0.0.1 URL を拒否する', () => {
        expect(() => validateCliUrl('http://127.0.0.1')).toThrow('private/loopback')
      })

      it('host.docker.internal URL を拒否する', () => {
        expect(() => validateCliUrl('http://host.docker.internal:8080')).toThrow('private/loopback')
      })

      it('192.168.1.1 URL を拒否する', () => {
        expect(() => validateCliUrl('http://192.168.1.1')).toThrow('private/loopback')
      })

      it('10.0.0.1 URL を拒否する', () => {
        expect(() => validateCliUrl('http://10.0.0.1')).toThrow('private/loopback')
      })
    })

    describe('表記ゆれバイパス対策', () => {
      it('http://localhost./ (末尾ドット) を拒否する', () => {
        expect(() => validateCliUrl('http://localhost./')).toThrow('private/loopback')
      })

      it('http://[::ffff:127.0.0.1]/ (IPv4-mapped IPv6) を拒否する', () => {
        expect(() => validateCliUrl('http://[::ffff:127.0.0.1]/')).toThrow('private/loopback')
      })

      it('http://localhost.localdomain/ を拒否する', () => {
        expect(() => validateCliUrl('http://localhost.localdomain/')).toThrow('private/loopback')
      })
    })
  })

  describe('validateUrlOriginMatch', () => {
    describe('許可ケース', () => {
      it('同一オリジンの URL を許可する', () => {
        expect(() =>
          validateUrlOriginMatch('https://example.com', 'https://example.com')
        ).not.toThrow()
      })

      it('同一オリジンでパスが異なる URL を許可する（リダイレクト等）', () => {
        expect(() =>
          validateUrlOriginMatch('https://example.com/page', 'https://example.com/redirected')
        ).not.toThrow()
      })

      it('HTTP -> HTTPS の昇格を許可する', () => {
        expect(() =>
          validateUrlOriginMatch('http://example.com/page', 'https://example.com/page')
        ).not.toThrow()
      })

      it('www. プレフィクスの追加を許可する', () => {
        expect(() =>
          validateUrlOriginMatch('https://example.com', 'https://www.example.com')
        ).not.toThrow()
      })

      it('www. プレフィクスの除去を許可する', () => {
        expect(() =>
          validateUrlOriginMatch('https://www.example.com', 'https://example.com')
        ).not.toThrow()
      })

      it('HTTPS 昇格と www. 追加の組み合わせを許可する', () => {
        expect(() =>
          validateUrlOriginMatch('http://example.com', 'https://www.example.com')
        ).not.toThrow()
      })
    })

    describe('拒否ケース（fail-closed）', () => {
      it('異なるオリジンの URL を拒否する', () => {
        expect(() =>
          validateUrlOriginMatch('https://example.com', 'https://malicious.com')
        ).toThrow('許容範囲外のオリジン')
      })

      it('HTTPS から HTTP への降格を拒否する', () => {
        expect(() => validateUrlOriginMatch('https://example.com', 'http://example.com')).toThrow(
          '許容範囲外のオリジン'
        )
      })

      it('CDN 等のサブドメイン変更を拒否する', () => {
        expect(() =>
          validateUrlOriginMatch('https://example.com', 'https://cdn.example.com')
        ).toThrow('許容範囲外のオリジン')
      })

      it('ポートが異なる URL を拒否する', () => {
        expect(() =>
          validateUrlOriginMatch('https://example.com', 'https://example.com:8080')
        ).toThrow('許容範囲外のオリジン')
      })

      it('別の TLD への遷移を拒否する', () => {
        expect(() => validateUrlOriginMatch('https://example.com', 'https://example.org')).toThrow(
          '許容範囲外のオリジン'
        )
      })

      it('パース不能な URL でエラーを投げる', () => {
        expect(() => validateUrlOriginMatch('not-a-url', 'https://example.com')).toThrow(
          'オリジン比較に失敗'
        )
      })

      it('fetched URL が private host の場合に拒否する', () => {
        expect(() =>
          validateUrlOriginMatch('https://example.com', 'http://localhost:8080/data')
        ).toThrow('private/loopback')
      })

      it('fetched URL が host.docker.internal の場合に拒否する', () => {
        expect(() =>
          validateUrlOriginMatch('https://example.com', 'http://host.docker.internal:8080')
        ).toThrow('private/loopback')
      })
    })
  })

  describe('extractRawText', () => {
    describe('正常系', () => {
      it('正常な Gemini ラッパー出力から raw_text を抽出する', () => {
        const wrapper = buildGeminiWrapper({
          error_message: '',
          fetch_success: true,
          raw_text: 'Hello World',
          url: 'https://example.com',
        })
        const result = extractRawText(wrapper)
        expect(result.url).toBe('https://example.com')
        expect(result.rawText).toBe('Hello World')
      })
    })

    describe('入力検証', () => {
      it('入力がオブジェクトでない場合にエラーを投げる', () => {
        expect(() => extractRawText('not an object')).toThrow('JSON オブジェクト')
      })

      it('入力が配列の場合にエラーを投げる', () => {
        expect(() => extractRawText([1, 2, 3])).toThrow('JSON オブジェクト')
      })

      it('入力が null の場合にエラーを投げる', () => {
        expect(() => extractRawText(null)).toThrow('JSON オブジェクト')
      })
    })

    describe('Gemini ラッパー検証', () => {
      it('error フィールドが存在する場合に fail-closed する', () => {
        const wrapper = buildGeminiWrapper(
          { error_message: '', fetch_success: false, raw_text: '', url: 'https://example.com' },
          { error: 'API error occurred' }
        )
        expect(() => extractRawText(wrapper)).toThrow('Gemini CLI がエラーを返しました')
      })

      it('response が文字列でない場合にエラーを投げる', () => {
        expect(() =>
          extractRawText({
            response: 123,
            session_id: 'test',
            stats: { tools: { byName: { web_fetch: { count: 1, success: 1 } } } },
          })
        ).toThrow('response フィールドが文字列ではありません')
      })
    })

    describe('web_fetch stats 検証', () => {
      it('web_fetch が呼ばれていない場合に WebFetchDenyError を投げる', () => {
        const wrapper = buildGeminiWrapper(
          { error_message: '', fetch_success: true, raw_text: 'text', url: 'https://example.com' },
          {
            stats: {
              tools: {
                byName: {},
                totalCalls: 0,
                totalFail: 0,
                totalSuccess: 0,
              },
            },
          }
        )
        expect(() => extractRawText(wrapper)).toThrow('web_fetch が存在しないか不正です')
      })

      it('web_fetch count が 0 の場合に WebFetchDenyError を投げる', () => {
        const wrapper = buildGeminiWrapper(
          { error_message: '', fetch_success: true, raw_text: 'text', url: 'https://example.com' },
          {
            stats: {
              tools: {
                byName: {
                  web_fetch: { count: 0, fail: 0, success: 0 },
                },
                totalCalls: 0,
              },
            },
          }
        )
        expect(() => extractRawText(wrapper)).toThrow('呼び出し回数が 0')
      })

      it('web_fetch success が 0 の場合にエラーを投げる', () => {
        const wrapper = buildGeminiWrapper(
          { error_message: '', fetch_success: true, raw_text: 'text', url: 'https://example.com' },
          {
            stats: {
              tools: {
                byName: {
                  web_fetch: { count: 1, fail: 1, success: 0 },
                },
                totalCalls: 1,
              },
            },
          }
        )
        expect(() => extractRawText(wrapper)).toThrow('成功回数が 0')
      })

      it('stats がオブジェクトでない場合に WebFetchDenyError を投げる', () => {
        const wrapper = buildGeminiWrapper(
          { error_message: '', fetch_success: true, raw_text: 'text', url: 'https://example.com' },
          { stats: 'invalid' }
        )
        expect(() => extractRawText(wrapper)).toThrow(
          'stats フィールドがオブジェクトではありません'
        )
      })
    })

    describe('additionalProperties 検証', () => {
      it('未知フィールドが含まれる場合にエラーを投げる', () => {
        const wrapper = buildGeminiWrapper({
          error_message: '',
          extra_field: 'should not be here',
          fetch_success: true,
          raw_text: 'text',
          url: 'https://example.com',
        })
        expect(() => extractRawText(wrapper)).toThrow('未知のフィールド')
      })

      it('許可フィールドのみの場合は通過する', () => {
        const wrapper = buildGeminiWrapper({
          error_message: '',
          fetch_success: true,
          raw_text: 'text',
          url: 'https://example.com',
        })
        const result = extractRawText(wrapper)
        expect(result.rawText).toBe('text')
      })
    })

    describe('response 内 JSON 検証', () => {
      it('response が JSON でない場合のフォールバック抽出', () => {
        const inner = {
          error_message: '',
          fetch_success: true,
          raw_text: 'Hello',
          url: 'https://example.com',
        }
        const wrapper = {
          response: `Here is the result: ${JSON.stringify(inner)}`,
          session_id: 'test',
          stats: {
            tools: {
              byName: { web_fetch: { count: 1, success: 1 } },
            },
          },
        }
        const result = extractRawText(wrapper)
        expect(result.url).toBe('https://example.com')
        expect(result.rawText).toBe('Hello')
      })

      it('response に JSON が全く含まれない場合に fail-closed する', () => {
        const wrapper = {
          response: 'plain text without any json',
          session_id: 'test',
          stats: {
            tools: {
              byName: { web_fetch: { count: 1, success: 1 } },
            },
          },
        }
        expect(() => extractRawText(wrapper)).toThrow('JSON オブジェクトの抽出にも失敗しました')
      })

      it('fetch_success が false の場合に fail-closed する', () => {
        const wrapper = buildGeminiWrapper({
          error_message: '404 Not Found',
          fetch_success: false,
          raw_text: '',
          url: 'https://example.com',
        })
        expect(() => extractRawText(wrapper)).toThrow('404 Not Found')
      })

      it('fetch_success が boolean でない場合にエラーを投げる', () => {
        const wrapper = buildGeminiWrapper({
          error_message: '',
          fetch_success: 'true',
          raw_text: 'text',
          url: 'https://example.com',
        })
        expect(() => extractRawText(wrapper)).toThrow('fetch_success が boolean ではありません')
      })

      it('raw_text が文字列でない場合にエラーを投げる', () => {
        const wrapper = buildGeminiWrapper({
          error_message: '',
          fetch_success: true,
          raw_text: 42,
          url: 'https://example.com',
        })
        expect(() => extractRawText(wrapper)).toThrow('raw_text が文字列ではありません')
      })

      it('url が文字列でない場合にエラーを投げる', () => {
        const wrapper = buildGeminiWrapper({
          error_message: '',
          fetch_success: true,
          raw_text: 'text',
          url: 123,
        })
        expect(() => extractRawText(wrapper)).toThrow('url が文字列ではありません')
      })

      it('error_message が 500 文字を超える場合に truncate する', () => {
        const longError = 'x'.repeat(600)
        const wrapper = buildGeminiWrapper({
          error_message: longError,
          fetch_success: false,
          raw_text: '',
          url: 'https://example.com',
        })
        expect(() => extractRawText(wrapper)).toThrow('Gemini の web_fetch が失敗しました')
      })
    })
  })

  describe('readStdinTrim', () => {
    it('上限以下の入力を読み取り trim する', async () => {
      const source = yieldChunks([new TextEncoder().encode('  hello  ')])
      const result = await readStdinTrim(source, 100)
      expect(result).toBe('hello')
    })

    it('上限を超えた時点で fail-closed する', async () => {
      const source = yieldChunks([
        new TextEncoder().encode('a'.repeat(60)),
        new TextEncoder().encode('b'.repeat(60)),
      ])
      await expect(readStdinTrim(source, 100)).rejects.toThrow('stdin が上限を超えました')
    })

    it('複数チャンクの累積で判定される (1 チャンク単独では超えない)', async () => {
      const source = yieldChunks([
        new TextEncoder().encode('a'.repeat(60)),
        new TextEncoder().encode('b'.repeat(40)),
        new TextEncoder().encode('c'),
      ])
      await expect(readStdinTrim(source, 100)).rejects.toThrow('stdin が上限を超えました')
    })
  })

  describe('パイプライン統合テスト', () => {
    it('正常な入力をサニタイズして出力する', () => {
      const wrapper = buildGeminiWrapper({
        error_message: '',
        fetch_success: true,
        raw_text: 'Normal text with <|im_start|> injection',
        url: 'https://example.com',
      })
      const { url, rawText } = extractRawText(wrapper)
      const result = sanitize(url, url, rawText)
      expect(result.requested_url).toBe('https://example.com')
      expect(result.fetched_url).toBe('https://example.com')
      expect(result.text).toContain('[FILTERED:chat_template]')
      expect(result.text).not.toContain('<|im_start|>')
      expect(result.flags.suspicious_patterns.chat_template).toBeGreaterThanOrEqual(1)
    })

    it('隔離プロセスが異なるオリジンの URL を返した場合にエラーを投げる', () => {
      const wrapper = buildGeminiWrapper({
        error_message: '',
        fetch_success: true,
        raw_text: 'safe content',
        url: 'https://malicious.com',
      })
      const { url: fetchedUrl } = extractRawText(wrapper)
      const cliUrl = 'https://example.com'
      expect(() => validateUrlOriginMatch(cliUrl, fetchedUrl)).toThrow('許容範囲外のオリジン')
    })

    it('同一オリジン内のリダイレクトを許容し両 URL を保持する', () => {
      const wrapper = buildGeminiWrapper({
        error_message: '',
        fetch_success: true,
        raw_text: 'content',
        url: 'https://example.com/redirected',
      })
      const { url: fetchedUrl, rawText } = extractRawText(wrapper)
      const cliUrl = 'https://example.com/original'
      validateUrlOriginMatch(cliUrl, fetchedUrl)
      const result = sanitize(cliUrl, fetchedUrl, rawText)
      expect(result.requested_url).toBe('https://example.com/original')
      expect(result.fetched_url).toBe('https://example.com/redirected')
    })

    it('不可視 Unicode 文字を含むテキストをサニタイズする', () => {
      const wrapper = buildGeminiWrapper({
        error_message: '',
        fetch_success: true,
        raw_text: 'text\u{E0069}\u{E0067}\u200Bmore',
        url: 'https://example.com',
      })
      const { url, rawText } = extractRawText(wrapper)
      const result = sanitize(url, url, rawText)
      expect(result.text).toBe('textmore')
      expect(result.flags.had_invisible_chars).toBe(true)
    })
  })
}
