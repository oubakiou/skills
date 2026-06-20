/**
 * URL を direct HTTP fetch し、pipe-sanitize-codex.ts が読む JSON を出力する。
 * @example node http-fetch-codex.ts "https://example.com"
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

interface FetchOutput {
  error_message: string
  fetch_success: boolean
  raw_text: string
  summary_text: string
  url: string
}

interface FetchOptions {
  fetchImpl?: typeof fetch
  maxBytes?: number
  maxRedirects?: number
  resolveHostname?: (hostname: string) => Promise<string[]>
  timeoutMs?: number
}

interface ReadContext {
  chunks: Uint8Array[]
  maxBytes: number
  reader: ReadableStreamDefaultReader<Uint8Array>
  totalBytes: number
}

interface FetchContext {
  fetchImpl: typeof fetch
  maxBytes: number
  originalUrl: URL
  resolveHostname: (hostname: string) => Promise<string[]>
  timeoutMs: number
}

export const MAX_RESPONSE_BYTES = 1_000_000
export const MAX_REDIRECTS = 5
export const MAX_SUMMARY_CHARS = 4000
export const FETCH_TIMEOUT_MS = 20_000

const ALLOWED_CONTENT_TYPES = [
  'application/atom+xml',
  'application/json',
  'application/ld+json',
  'application/rss+xml',
  'application/xhtml+xml',
  'application/xml',
  'text/',
]

const METADATA_IPS = new Set(['169.254.169.254'])

const parseUrl = (url: string): URL => {
  try {
    return new URL(url)
  } catch {
    throw new Error(`URL のパースに失敗しました: ${url}`)
  }
}

export const validateHttpUrl = (url: URL): void => {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `URL のプロトコルが不正です (${url.protocol}). http: または https: のみ許可されます`
    )
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('URL に userinfo を含めることはできません')
  }
}

const isLocalHostname = (hostname: string): boolean => {
  const lower = hostname.toLowerCase()
  return lower === 'localhost' || lower.endsWith('.localhost')
}

const parseIpv4 = (address: string): number[] | null => {
  const parts = address.split('.')
  if (parts.length !== 4) {
    return null
  }
  const octets = parts.map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null
  }
  return octets
}

const isBlockedIpv4 = (address: string): boolean => {
  const octets = parseIpv4(address)
  if (octets === null) {
    return true
  }
  const [firstOctet, secondOctet] = octets
  return (
    firstOctet === 0 ||
    firstOctet === 10 ||
    firstOctet === 127 ||
    firstOctet >= 224 ||
    (firstOctet === 100 && secondOctet >= 64 && secondOctet <= 127) ||
    (firstOctet === 169 && secondOctet === 254) ||
    (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||
    (firstOctet === 192 && secondOctet === 168) ||
    METADATA_IPS.has(address)
  )
}

const IPV4_MAPPED_PREFIX = '::ffff:'

const extractMappedIpv4 = (ipv6Lower: string): string | null => {
  if (!ipv6Lower.startsWith(IPV4_MAPPED_PREFIX)) {
    return null
  }
  const v4Part = ipv6Lower.slice(IPV4_MAPPED_PREFIX.length)
  if (isIP(v4Part) === 4) {
    return v4Part
  }
  return null
}

const isBlockedIpv6 = (address: string): boolean => {
  const lower = address.toLowerCase()
  const mappedV4 = extractMappedIpv4(lower)
  if (mappedV4 !== null) {
    return isBlockedIpv4(mappedV4)
  }
  return (
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('ff')
  )
}

export const isBlockedAddress = (address: string): boolean => {
  const family = isIP(address)
  if (family === 4) {
    return isBlockedIpv4(address)
  }
  if (family === 6) {
    return isBlockedIpv6(address)
  }
  return true
}

const defaultResolveHostname = async (hostname: string): Promise<string[]> => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

const resolveUrlAddresses = async (
  url: URL,
  resolveHostname: (hostname: string) => Promise<string[]>
): Promise<string[]> => {
  if (isIP(url.hostname) !== 0) {
    return [url.hostname]
  }
  return resolveHostname(url.hostname)
}

export const validateNetworkTarget = async (
  url: URL,
  resolveHostname: (hostname: string) => Promise<string[]> = defaultResolveHostname
): Promise<void> => {
  validateHttpUrl(url)
  if (isLocalHostname(url.hostname)) {
    throw new Error(`内部ホストへのアクセスは許可されません: ${url.hostname}`)
  }
  const addresses = await resolveUrlAddresses(url, resolveHostname)
  if (addresses.length === 0) {
    throw new Error(`DNS 解決結果が空です: ${url.hostname}`)
  }
  const blocked = addresses.find((address) => isBlockedAddress(address))
  if (typeof blocked === 'string') {
    throw new Error(`内部アドレスへのアクセスは許可されません: ${blocked}`)
  }
}

const validateContentType = (contentType: string): void => {
  const [mimeType = ''] = contentType.toLowerCase().split(';', 1)
  const lower = mimeType.trim()
  if (lower.length === 0) {
    throw new Error('content-type が空です')
  }
  if (!ALLOWED_CONTENT_TYPES.some((allowed) => lower === allowed || lower.startsWith(allowed))) {
    throw new Error(`許可されていない content-type です: ${contentType}`)
  }
}

const readChunks = async (context: ReadContext): Promise<Uint8Array[]> => {
  const { done, value } = await context.reader.read()
  if (done) {
    return context.chunks
  }
  const nextTotalBytes = context.totalBytes + value.byteLength
  if (nextTotalBytes > context.maxBytes) {
    throw new Error(`レスポンスが上限を超えました (${nextTotalBytes} > ${context.maxBytes} bytes)`)
  }
  context.chunks.push(value)
  return readChunks({ ...context, totalBytes: nextTotalBytes })
}

const readResponseText = async (response: Response, maxBytes: number): Promise<string> => {
  const chunks: Uint8Array[] = []
  if (response.body === null) {
    return ''
  }
  const reader = response.body.getReader()
  return Buffer.concat(await readChunks({ chunks, maxBytes, reader, totalBytes: 0 })).toString(
    'utf8'
  )
}

const decodeEntities = (text: string): string =>
  text
    .replace(/&(?:amp|#38);/gi, '&')
    .replace(/&(?:lt|#60);/gi, '<')
    .replace(/&(?:gt|#62);/gi, '>')
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#([0-9]+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )

const collapseWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim()

const stripHtml = (html: string): string => {
  const withoutIgnored = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
  return collapseWhitespace(decodeEntities(withoutIgnored.replace(/<[^>]+>/g, ' ')))
}

const extractTagContents = (html: string, tagName: string): string[] => {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi')
  return [...html.matchAll(pattern)].map((match) => match[1] ?? '')
}

const JSON_TEXT_KEYS = new Set(['articleBody', 'body', 'description', 'headline', 'name', 'text'])

const isJsonTextKey = (key: string): boolean => JSON_TEXT_KEYS.has(key)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const jsonChildren = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .filter(([key]) => isJsonTextKey(key))
      .map(([, nested]) => nested)
  }
  return []
}

const collectJsonStrings = (value: unknown, texts: string[]): void => {
  if (typeof value === 'string') {
    texts.push(stripHtml(value))
    return
  }
  for (const nested of jsonChildren(value)) {
    collectJsonStrings(nested, texts)
  }
}

export const extractJsonText = (json: string): string[] => {
  try {
    const parsed = JSON.parse(json) as unknown
    const texts: string[] = []
    collectJsonStrings(parsed, texts)
    return texts.filter((text) => text.length > 0)
  } catch {
    return []
  }
}

const extractJsonLdText = (html: string): string[] => {
  const scripts = [
    ...html.matchAll(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    ),
  ].map((match) => decodeEntities(match[1] ?? ''))
  return scripts.flatMap((script) => extractJsonText(script))
}

const longestText = (texts: string[], fallback: string): string => {
  const sortedTexts = texts.toSorted((leftText, rightText) => rightText.length - leftText.length)
  return sortedTexts[0] ?? fallback
}

export const extractHtmlText = (html: string): string => {
  const title = extractTagContents(html, 'title')
    .map(stripHtml)
    .find((text) => text.length > 0)
  const jsonLdTexts = extractJsonLdText(html)
  const candidates = [
    ...extractTagContents(html, 'article'),
    ...extractTagContents(html, 'main'),
    ...extractTagContents(html, 'body'),
  ]
    .map(stripHtml)
    .filter((text) => text.length > 0)
  const body = longestText(candidates, stripHtml(html))
  const parts = [...jsonLdTexts, body].filter((text) => text.length > 0)
  if (typeof title === 'string') {
    return [title, ...parts].join('\n\n')
  }
  return parts.join('\n\n')
}

const extractJsonBodyText = (body: string): string => {
  const jsonTexts = extractJsonText(body)
  if (jsonTexts.length > 0) {
    return jsonTexts.join('\n\n')
  }
  return body
}

export const extractBodyText = (body: string, contentType: string): string => {
  const lower = contentType.toLowerCase()
  if (lower.includes('html')) {
    return extractHtmlText(body)
  }
  if (lower.includes('json')) {
    return extractJsonBodyText(body)
  }
  if (lower.includes('xml')) {
    return stripHtml(body)
  }
  return collapseWhitespace(body)
}

const truncateText = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) {
    return text
  }
  return `${text.slice(0, maxChars).trimEnd()}...`
}

const splitSentences = (text: string): string[] => {
  const matches = text.match(/[^。.!?！？]+[。.!?！？]?/g)
  return matches ?? [text]
}

interface SummaryAccumulator {
  length: number
  parts: string[]
}

interface AppendResult {
  accumulator: SummaryAccumulator
  added: boolean
}

interface AppendInput {
  accumulator: SummaryAccumulator
  gap: number
  maxChars: number
  text: string
}

const summaryParagraphs = (rawText: string): string[] =>
  rawText
    .split(/\n{2,}/)
    .map(collapseWhitespace)
    .filter((paragraph) => paragraph.length > 0)

const gapLength = (parts: string[], gap: number): number => {
  if (parts.length === 0) {
    return 0
  }
  return gap
}

const measuredLength = (accumulator: SummaryAccumulator, text: string, gap: number): number =>
  accumulator.length + text.length + gapLength(accumulator.parts, gap)

const appendPart = (
  accumulator: SummaryAccumulator,
  text: string,
  gap: number
): SummaryAccumulator => ({
  length: measuredLength(accumulator, text, gap),
  parts: [...accumulator.parts, text],
})

const appendIfFits = ({ accumulator, gap, maxChars, text }: AppendInput): AppendResult => {
  if (measuredLength(accumulator, text, gap) > maxChars) {
    return { accumulator, added: false }
  }
  return { accumulator: appendPart(accumulator, text, gap), added: true }
}

const appendSentenceSummary = (
  paragraph: string,
  accumulator: SummaryAccumulator,
  maxChars: number
): SummaryAccumulator => {
  let current = accumulator
  for (const sentence of splitSentences(paragraph).map(collapseWhitespace)) {
    const result = appendIfFits({ accumulator: current, gap: 1, maxChars, text: sentence })
    if (!result.added) {
      break
    }
    current = result.accumulator
  }
  return current
}

const buildSummary = (paragraphs: string[], maxChars: number): SummaryAccumulator => {
  let current: SummaryAccumulator = { length: 0, parts: [] }
  for (const paragraph of paragraphs) {
    const result = appendIfFits({ accumulator: current, gap: 2, maxChars, text: paragraph })
    if (!result.added) {
      return appendSentenceSummary(paragraph, current, maxChars)
    }
    current = result.accumulator
  }
  return current
}

export const summarizeText = (rawText: string, maxChars: number = MAX_SUMMARY_CHARS): string => {
  const paragraphs = summaryParagraphs(rawText)
  const summary = buildSummary(paragraphs, maxChars).parts.join('\n\n')
  if (summary.length === 0) {
    return truncateText(collapseWhitespace(rawText), maxChars)
  }
  return truncateText(summary, maxChars)
}

const formatErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

const buildFailure = (url: string, error: unknown): FetchOutput => ({
  error_message: formatErrorMessage(error),
  fetch_success: false,
  raw_text: '',
  summary_text: '',
  url,
})

const buildSuccess = (url: string, rawText: string): FetchOutput => ({
  error_message: '',
  fetch_success: true,
  raw_text: rawText,
  summary_text: summarizeText(rawText),
  url,
})

const fetchWithTimeout = async (
  url: URL,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<Response> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url.href, {
      headers: {
        accept: 'text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1',
        'user-agent': 'guarded-webfetch-codex/1.0',
      },
      redirect: 'manual',
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

const responseUrl = (response: Response, fallbackUrl: URL): string => {
  if (response.url.length > 0) {
    return response.url
  }
  return fallbackUrl.href
}

const isRedirect = (response: Response): boolean => response.status >= 300 && response.status < 400

const redirectTarget = (response: Response, currentUrl: URL): URL => {
  const location = response.headers.get('location')
  if (location === null || location.length === 0) {
    throw new Error(`リダイレクト Location が空です (status: ${response.status})`)
  }
  return new URL(location, currentUrl)
}

const stripWwwPrefix = (hostname: string): string => hostname.replace(/^www\./i, '')

const isAllowedOriginTransition = (requested: URL, fetched: URL): boolean => {
  const schemeOk =
    requested.protocol === fetched.protocol ||
    (requested.protocol === 'http:' && fetched.protocol === 'https:')
  const hostOk = stripWwwPrefix(requested.hostname) === stripWwwPrefix(fetched.hostname)
  const portOk = requested.port === fetched.port
  return schemeOk && hostOk && portOk
}

const validateRedirectTarget = (originalUrl: URL, nextUrl: URL): void => {
  if (!isAllowedOriginTransition(originalUrl, nextUrl)) {
    throw new Error(
      `許容範囲外のリダイレクトです (requested: ${originalUrl.origin}, fetched: ${nextUrl.origin})`
    )
  }
}

const fetchSuccessResponse = async (
  currentUrl: URL,
  response: Response,
  context: FetchContext
): Promise<FetchOutput> => {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`.trim())
  }
  const contentType = response.headers.get('content-type') ?? ''
  validateContentType(contentType)
  const responseBody = await readResponseText(response, context.maxBytes)
  return buildSuccess(responseUrl(response, currentUrl), extractBodyText(responseBody, contentType))
}

const fetchFollowingRedirects = async (
  currentUrl: URL,
  context: FetchContext,
  redirectsRemaining: number
): Promise<FetchOutput> => {
  await validateNetworkTarget(currentUrl, context.resolveHostname)
  const response = await fetchWithTimeout(currentUrl, context.fetchImpl, context.timeoutMs)
  if (isRedirect(response)) {
    if (redirectsRemaining <= 0) {
      throw new Error('リダイレクト回数が上限を超えました')
    }
    const nextUrl = redirectTarget(response, currentUrl)
    validateRedirectTarget(context.originalUrl, nextUrl)
    return fetchFollowingRedirects(nextUrl, context, redirectsRemaining - 1)
  }
  return fetchSuccessResponse(currentUrl, response, context)
}

export const fetchUrl = async (
  inputUrl: string,
  options: FetchOptions = {}
): Promise<FetchOutput> => {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS
  const resolveHostname = options.resolveHostname ?? defaultResolveHostname
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS
  const currentUrl = parseUrl(inputUrl)
  const context = { fetchImpl, maxBytes, originalUrl: currentUrl, resolveHostname, timeoutMs }

  try {
    return await fetchFollowingRedirects(currentUrl, context, maxRedirects)
  } catch (error) {
    return buildFailure(currentUrl.href, error)
  }
}

const main = async (): Promise<void> => {
  const [url] = process.argv.slice(2)
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('Usage: http-fetch-codex.ts <URL>')
  }
  const result = await fetchUrl(url)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

const textResponse = (body: string, init?: ResponseInit): Response => new Response(body, init)
const binaryResponse = (body: string, init?: ResponseInit): Response =>
  new Response(Buffer.from(body), init)

const resolvePublic = async (): Promise<string[]> => ['93.184.216.34']

const requestHref = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === 'string') {
    return input
  }
  if (input instanceof URL) {
    return input.href
  }
  return input.url
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('validateNetworkTarget', () => {
    it('http / https URL を許可する', async () => {
      await expect(
        validateNetworkTarget(new URL('https://example.com'), resolvePublic)
      ).resolves.toBeUndefined()
    })

    it('非 HTTP scheme を拒否する', async () => {
      await expect(
        validateNetworkTarget(new URL('file:///etc/passwd'), resolvePublic)
      ).rejects.toThrow('プロトコルが不正')
    })

    it('localhost を拒否する', async () => {
      await expect(
        validateNetworkTarget(new URL('http://localhost'), resolvePublic)
      ).rejects.toThrow('内部ホスト')
    })

    it('private IP を拒否する', async () => {
      await expect(
        validateNetworkTarget(new URL('http://10.0.0.1'), resolvePublic)
      ).rejects.toThrow('内部アドレス')
    })

    it('DNS 解決後の private IP を拒否する', async () => {
      await expect(
        validateNetworkTarget(new URL('https://example.com'), async () => ['192.168.0.10'])
      ).rejects.toThrow('内部アドレス')
    })

    it('IPv4-mapped IPv6 の private IP を拒否する', async () => {
      await expect(
        validateNetworkTarget(new URL('https://example.com'), async () => ['::ffff:10.0.0.1'])
      ).rejects.toThrow('内部アドレス')
    })

    it('IPv4-mapped IPv6 の 172.2.x.x (public) を許可する', async () => {
      await expect(
        validateNetworkTarget(new URL('https://example.com'), async () => ['::ffff:172.2.1.1'])
      ).resolves.toBeUndefined()
    })

    it('IPv4-mapped IPv6 の 172.20.x.x (private) を拒否する', async () => {
      await expect(
        validateNetworkTarget(new URL('https://example.com'), async () => ['::ffff:172.20.0.1'])
      ).rejects.toThrow('内部アドレス')
    })
  })

  describe('extractBodyText', () => {
    it('HTML の title と article を抽出する', () => {
      const html =
        '<html><head><title>Hello</title></head><body><article>A &amp; B</article></body></html>'
      expect(extractBodyText(html, 'text/html')).toBe('Hello\n\nA & B')
    })

    it('Zenn 相当の JSON-LD と article から本文を抽出する', () => {
      const html = `
        <html>
          <head>
            <title>Zenn title</title>
            <script type="application/ld+json">
              {"headline":"記事タイトル","articleBody":"Zenn の記事本文です。"}
            </script>
          </head>
          <body><article><h1>記事タイトル</h1><p>本文の冒頭です。</p></article></body>
        </html>
      `
      const result = extractBodyText(html, 'text/html')
      expect(result).toContain('Zenn の記事本文です。')
      expect(result).toContain('本文の冒頭です。')
    })

    it('JSON の本文候補を抽出する', () => {
      const result = extractBodyText(
        JSON.stringify({ articleBody: '<p>JSON body</p>', headline: 'JSON title' }),
        'application/json'
      )
      expect(result).toContain('JSON body')
      expect(result).toContain('JSON title')
    })
  })

  describe('fetchUrl', () => {
    it('fetch 成功時に schema 互換 JSON を返す', async () => {
      const result = await fetchUrl('https://example.com/page', {
        fetchImpl: async () =>
          textResponse('<title>Example</title><article>Body</article>', {
            headers: { 'content-type': 'text/html' },
            status: 200,
          }),
        resolveHostname: resolvePublic,
      })
      expect(result.fetch_success).toBe(true)
      expect(result.url).toBe('https://example.com/page')
      expect(result.raw_text).toContain('Body')
    })

    it('許可外 content-type は失敗応答にする', async () => {
      const result = await fetchUrl('https://example.com/file', {
        fetchImpl: async () =>
          textResponse('png', {
            headers: { 'content-type': 'image/png' },
            status: 200,
          }),
        resolveHostname: resolvePublic,
      })
      expect(result.fetch_success).toBe(false)
      expect(result.error_message).toContain('content-type')
    })

    it('空 content-type は失敗応答にする', async () => {
      const result = await fetchUrl('https://example.com/file', {
        fetchImpl: async () => binaryResponse('unknown', { status: 200 }),
        resolveHostname: resolvePublic,
      })
      expect(result.fetch_success).toBe(false)
      expect(result.error_message).toContain('content-type')
    })

    it('クロスオリジンリダイレクト先も検証する', async () => {
      const result = await fetchUrl('https://example.com/start', {
        fetchImpl: async (url) => {
          if (requestHref(url).includes('/start')) {
            return textResponse('', {
              headers: { location: 'http://10.0.0.1/secret' },
              status: 302,
            })
          }
          return textResponse('secret', { status: 200 })
        },
        resolveHostname: resolvePublic,
      })
      expect(result.fetch_success).toBe(false)
      expect(result.error_message).toContain('リダイレクト')
    })

    it('HTTPS から HTTP へのリダイレクトは接続前に拒否する', async () => {
      const result = await fetchUrl('https://example.com/start', {
        fetchImpl: async (url) => {
          if (requestHref(url).includes('/start')) {
            return textResponse('', {
              headers: { location: 'http://example.com/plain' },
              status: 302,
            })
          }
          return textResponse('plain', {
            headers: { 'content-type': 'text/plain' },
            status: 200,
          })
        },
        resolveHostname: resolvePublic,
      })
      expect(result.fetch_success).toBe(false)
      expect(result.error_message).toContain('リダイレクト')
    })

    it('レスポンスサイズ上限を超えたら失敗応答にする', async () => {
      const result = await fetchUrl('https://example.com/large', {
        fetchImpl: async () =>
          textResponse('a'.repeat(20), {
            headers: { 'content-type': 'text/plain' },
            status: 200,
          }),
        maxBytes: 10,
        resolveHostname: resolvePublic,
      })
      expect(result.fetch_success).toBe(false)
      expect(result.error_message).toContain('上限を超えました')
    })

    it('リダイレクト回数上限を超えたら失敗応答にする', async () => {
      let redirectCount = 0
      const result = await fetchUrl('https://example.com/start', {
        fetchImpl: async () => {
          redirectCount += 1
          return textResponse('', {
            headers: { location: `https://example.com/hop${redirectCount}` },
            status: 302,
          })
        },
        maxRedirects: 3,
        resolveHostname: resolvePublic,
      })
      expect(result.fetch_success).toBe(false)
      expect(result.error_message).toContain('リダイレクト回数が上限')
    })
  })

  describe('summarizeText', () => {
    it('短いテキストはそのまま返す', () => {
      expect(summarizeText('short text', 100)).toBe('short text')
    })

    it('上限を超えるテキストを切り詰める', () => {
      const result = summarizeText('a'.repeat(200), 50)
      expect(result.length).toBeLessThanOrEqual(53)
      expect(result).toMatch(/\.\.\.$/u)
    })

    it('段落境界で分割する', () => {
      const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'
      const result = summarizeText(text, 40)
      expect(result).toContain('First paragraph.')
      expect(result).not.toContain('Third paragraph.')
    })

    it('buildSuccess 経由で summary_text がセットされる', async () => {
      const result = await fetchUrl('https://example.com/page', {
        fetchImpl: async () =>
          textResponse('Body text content', {
            headers: { 'content-type': 'text/plain' },
            status: 200,
          }),
        resolveHostname: resolvePublic,
      })
      expect(result.fetch_success).toBe(true)
      expect(result.summary_text.length).toBeGreaterThan(0)
      expect(result.summary_text).toBe('Body text content')
    })
  })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${formatErrorMessage(error)}\n`)
    process.exitCode = 1
  })
}
