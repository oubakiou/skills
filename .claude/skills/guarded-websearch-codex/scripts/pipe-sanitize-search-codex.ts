/**
 * Codex JSONL 出力から検索結果を抽出し、各 title/snippet を sanitize して stdout に出力する。
 * @example codex --search exec --json ... | node pipe-sanitize-search-codex.ts "<query>"
 */

import { type SanitizeFlags, type SuspiciousPatternCounts, sanitize } from './sanitize.ts'

interface SearchResult {
  snippet: string
  title: string
  url: string
}

interface CodexSearchOutput {
  error_message: string
  query: string
  results: SearchResult[]
  search_success: boolean
}

interface SanitizedSearchResult {
  snippet: string
  snippet_flags: SanitizeFlags
  title: string
  title_flags: SanitizeFlags
  url: string
}

interface SanitizedSearchOutput {
  aggregate_flags: {
    filtered_unsafe_urls: number
    had_invisible_chars: boolean
    /** カテゴリ別の累積件数。各 SanitizeFlags.suspicious_patterns を加算したもの */
    suspicious_patterns: SuspiciousPatternCounts
  }
  meta: {
    result_count: number
    sanitized_at: string
  }
  query: string
  results: SanitizedSearchResult[]
}

/** target に source の各カテゴリ件数を加算する（破壊的更新） */
const mergeSuspiciousCounts = (
  target: SuspiciousPatternCounts,
  source: SuspiciousPatternCounts
): void => {
  for (const [category, count] of Object.entries(source)) {
    target[category] = (target[category] ?? 0) + count
  }
}

interface AgentMessageEvent {
  item: { text: string; type: 'agent_message' }
  type: 'item.completed'
}

interface ErrorEvent {
  message: string
  type: 'error'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isAgentMessageEvent = (value: unknown): value is AgentMessageEvent => {
  if (!isRecord(value) || value.type !== 'item.completed' || !isRecord(value.item)) {
    return false
  }
  return value.item.type === 'agent_message' && typeof value.item.text === 'string'
}

const isErrorEvent = (value: unknown): value is ErrorEvent =>
  isRecord(value) && value.type === 'error' && typeof value.message === 'string'

const isSearchResult = (value: unknown): value is SearchResult => {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value.url === 'string' &&
    typeof value.title === 'string' &&
    typeof value.snippet === 'string'
  )
}

const isWebUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

const parseJsonStrict = (text: string, errorMessage: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(errorMessage)
  }
}

const validateString = (value: unknown, fieldName: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`Codex 出力の ${fieldName} が文字列ではありません`)
  }
  return value
}

const validateBoolean = (value: unknown, fieldName: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new Error(`Codex 出力の ${fieldName} が boolean ではありません`)
  }
  return value
}

const validateResultsArray = (value: unknown): SearchResult[] => {
  if (!Array.isArray(value)) {
    throw new Error('Codex 出力の results が配列ではありません')
  }
  return value.map((item, index) => {
    if (!isSearchResult(item)) {
      throw new Error(`Codex 出力の results[${index}] が不正な形式です`)
    }
    return item
  })
}

const parseCodexSearchOutput = (text: string): CodexSearchOutput => {
  const parsed = parseJsonStrict(text, 'Codex の最終メッセージが JSON ではありません')
  if (!isRecord(parsed)) {
    throw new Error('Codex の最終メッセージが JSON オブジェクトではありません')
  }
  return {
    error_message: validateString(parsed.error_message, 'error_message'),
    query: validateString(parsed.query, 'query'),
    results: validateResultsArray(parsed.results),
    search_success: validateBoolean(parsed.search_success, 'search_success'),
  }
}

const parseJsonlEvents = (jsonl: string): unknown[] =>
  jsonl
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .reduce<unknown[]>((acc, line) => {
      try {
        acc.push(JSON.parse(line))
      } catch {
        // JSON として解釈できない行は無視（Codex が JSONL に混在させる非構造化ログを想定）
      }
      return acc
    }, [])

const findLastAgentMessage = (events: unknown[]): string | undefined => {
  const last = events.findLast(isAgentMessageEvent)
  if (typeof last === 'undefined') {
    return last
  }
  return last.item.text
}

const findLastErrorMessage = (events: unknown[]): string | undefined => {
  const last = events.findLast(isErrorEvent)
  if (typeof last === 'undefined') {
    return last
  }
  return last.message
}

const handleMissingMessage = (events: unknown[]): never => {
  const lastError = findLastErrorMessage(events)
  if (typeof lastError === 'string') {
    throw new Error(`Codex 子プロセスが失敗しました: ${lastError}`)
  }
  throw new Error('Codex 子プロセスの最終 agent_message が見つかりません')
}

export const extractSearchResults = (jsonl: string): CodexSearchOutput => {
  const events = parseJsonlEvents(jsonl)
  const lastMessage = findLastAgentMessage(events)
  if (typeof lastMessage !== 'string') {
    return handleMissingMessage(events)
  }
  const output = parseCodexSearchOutput(lastMessage)
  if (!output.search_success) {
    throw new Error(`Codex search が失敗しました: ${output.error_message}`)
  }
  return output
}

const sanitizeSingleResult = (
  item: SearchResult
): { result: SanitizedSearchResult; invisible: boolean } => {
  const titleDoc = sanitize(item.url, item.url, item.title)
  const snippetDoc = sanitize(item.url, item.url, item.snippet)
  return {
    invisible: titleDoc.flags.had_invisible_chars || snippetDoc.flags.had_invisible_chars,
    result: {
      snippet: snippetDoc.text,
      snippet_flags: snippetDoc.flags,
      title: titleDoc.text,
      title_flags: titleDoc.flags,
      url: item.url,
    },
  }
}

export const sanitizeSearchResults = (
  query: string,
  results: SearchResult[]
): SanitizedSearchOutput => {
  const safeResults = results.filter((item) => isWebUrl(item.url))
  const filteredUnsafeUrls = results.length - safeResults.length
  const sanitized = safeResults.map((item) => sanitizeSingleResult(item))
  const suspiciousPatterns: SuspiciousPatternCounts = {}
  for (const entry of sanitized) {
    mergeSuspiciousCounts(suspiciousPatterns, entry.result.title_flags.suspicious_patterns)
    mergeSuspiciousCounts(suspiciousPatterns, entry.result.snippet_flags.suspicious_patterns)
  }
  const hadInvisibleChars = sanitized.some((entry) => entry.invisible)
  return {
    aggregate_flags: {
      filtered_unsafe_urls: filteredUnsafeUrls,
      had_invisible_chars: hadInvisibleChars,
      suspicious_patterns: suspiciousPatterns,
    },
    meta: {
      result_count: sanitized.length,
      sanitized_at: new Date().toISOString(),
    },
    query,
    results: sanitized.map((entry) => entry.result),
  }
}

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

const formatThrown = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

const main = async (): Promise<void> => {
  const [query] = process.argv.slice(2)
  if (typeof query !== 'string' || query.length === 0) {
    throw new Error('Usage: pipe-sanitize-search-codex.ts <QUERY>')
  }
  if (query.length > 1000) {
    throw new Error(`クエリが長すぎます (${query.length} 文字, 上限 1000)`)
  }
  const input = await readStdin()
  const output = extractSearchResults(input)
  process.stdout.write(`${JSON.stringify(sanitizeSearchResults(query, output.results))}\n`)
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('extractSearchResults', () => {
    it('Codex JSONL から検索結果を抽出する', () => {
      const input = [
        '{"type":"thread.started"}',
        String.raw`{"type":"item.completed","item":{"type":"agent_message","text":"{\"query\":\"ai news\",\"results\":[{\"url\":\"https://example.com\",\"title\":\"Example\",\"snippet\":\"hello\"}],\"search_success\":true,\"error_message\":\"\"}"}}`,
      ].join('\n')
      const result = extractSearchResults(input)
      expect(result.query).toBe('ai news')
      expect(result.results).toHaveLength(1)
    })

    it('error イベントしかない場合は失敗させる', () => {
      const input = '{"type":"error","message":"boom"}'
      expect(() => extractSearchResults(input)).toThrow('boom')
    })
  })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${formatThrown(error)}\n`)
    process.exitCode = 1
  })
}
