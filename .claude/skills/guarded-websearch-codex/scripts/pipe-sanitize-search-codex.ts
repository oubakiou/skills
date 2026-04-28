/**
 * Codex JSONL 出力から検索結果を抽出し、各 title/snippet を sanitize して stdout に出力する。
 * @example codex --search exec --json ... | node pipe-sanitize-search-codex.ts "<query>"
 */

import { type SanitizeFlags, sanitize } from './sanitize.ts'

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
    suspicious_patterns: string[]
  }
  meta: {
    result_count: number
    sanitized_at: string
  }
  query: string
  results: SanitizedSearchResult[]
}

interface AgentMessageEvent {
  item?: {
    text?: string
    type?: string
  }
  type?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isAgentMessageEvent = (value: unknown): value is AgentMessageEvent => {
  if (!isRecord(value) || value.type !== 'item.completed' || !isRecord(value.item)) {
    return false
  }
  return value.item.type === 'agent_message' && typeof value.item.text === 'string'
}

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

const parseCodexSearchOutput = (text: string): CodexSearchOutput => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Codex の最終メッセージが JSON ではありません')
  }
  if (!isRecord(parsed)) {
    throw new Error('Codex の最終メッセージが JSON オブジェクトではありません')
  }
  if (typeof parsed.query !== 'string') {
    throw new Error('Codex 出力の query が文字列ではありません')
  }
  if (!Array.isArray(parsed.results)) {
    throw new Error('Codex 出力の results が配列ではありません')
  }
  const results = parsed.results.map((item, index) => {
    if (!isSearchResult(item)) {
      throw new Error(`Codex 出力の results[${index}] が不正な形式です`)
    }
    return item
  })
  if (typeof parsed.search_success !== 'boolean') {
    throw new Error('Codex 出力の search_success が boolean ではありません')
  }
  if (typeof parsed.error_message !== 'string') {
    throw new Error('Codex 出力の error_message が文字列ではありません')
  }
  return {
    error_message: parsed.error_message,
    query: parsed.query,
    results,
    search_success: parsed.search_success,
  }
}

export const extractSearchResults = (jsonl: string): CodexSearchOutput => {
  const lines = jsonl
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  let lastMessage: string | null = null
  let lastError: string | null = null

  for (const line of lines) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (isAgentMessageEvent(event)) {
      lastMessage = event.item?.text ?? null
      continue
    }
    if (isRecord(event) && event.type === 'error' && typeof event.message === 'string') {
      lastError = event.message
    }
  }

  if (lastMessage === null) {
    if (lastError !== null) {
      throw new Error(`Codex 子プロセスが失敗しました: ${lastError}`)
    }
    throw new Error('Codex 子プロセスの最終 agent_message が見つかりません')
  }

  const output = parseCodexSearchOutput(lastMessage)
  if (!output.search_success) {
    throw new Error(`Codex search が失敗しました: ${output.error_message}`)
  }
  return output
}

export const sanitizeSearchResults = (
  query: string,
  results: SearchResult[]
): SanitizedSearchOutput => {
  const suspiciousPatterns: string[] = []
  let hadInvisibleChars = false
  let filteredUnsafeUrls = 0

  const sanitizedResults: SanitizedSearchResult[] = []

  for (const item of results) {
    if (!isWebUrl(item.url)) {
      filteredUnsafeUrls += 1
      continue
    }

    const titleDoc = sanitize(item.url, item.url, item.title)
    const snippetDoc = sanitize(item.url, item.url, item.snippet)

    suspiciousPatterns.push(...titleDoc.flags.suspicious_patterns)
    suspiciousPatterns.push(...snippetDoc.flags.suspicious_patterns)
    if (titleDoc.flags.had_invisible_chars || snippetDoc.flags.had_invisible_chars) {
      hadInvisibleChars = true
    }

    sanitizedResults.push({
      snippet: snippetDoc.text,
      snippet_flags: snippetDoc.flags,
      title: titleDoc.text,
      title_flags: titleDoc.flags,
      url: item.url,
    })
  }

  return {
    aggregate_flags: {
      filtered_unsafe_urls: filteredUnsafeUrls,
      had_invisible_chars: hadInvisibleChars,
      suspicious_patterns: suspiciousPatterns,
    },
    meta: {
      result_count: sanitizedResults.length,
      sanitized_at: new Date().toISOString(),
    },
    query,
    results: sanitizedResults,
  }
}

const main = async (): Promise<void> => {
  const query = process.argv[2]
  if (typeof query !== 'string' || query.length === 0) {
    throw new Error('Usage: pipe-sanitize-search-codex.ts <QUERY>')
  }

  let input = ''
  for await (const chunk of process.stdin) {
    input += String(chunk)
  }

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
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exit(1)
  })
}
