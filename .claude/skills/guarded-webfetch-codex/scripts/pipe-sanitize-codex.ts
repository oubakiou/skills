/**
 * Codex JSONL 出力を stdin から読み、最終 agent_message を sanitize して stdout に出力する。
 * @example codex --search exec --json ... | node pipe-sanitize-codex.ts "<url>"
 */

import { sanitize } from './sanitize.ts'

interface CodexFetchOutput {
  error_message: string
  fetch_success: boolean
  raw_text: string
  url: string
}

interface AgentMessageEvent {
  item: { text: string; type: 'agent_message' }
  type: 'item.completed'
}

interface ErrorEvent {
  message: string
  type: 'error'
}

const parseUrl = (url: string): URL => {
  try {
    return new URL(url)
  } catch {
    throw new Error(`URL のパースに失敗しました: ${url}`)
  }
}

export const validateCliUrl = (url: string): void => {
  const parsed = parseUrl(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `URL のプロトコルが不正です (${parsed.protocol}). http: または https: のみ許可されます`
    )
  }
}

export const validateUrlOriginMatch = (requestedUrl: string, fetchedUrl: string): void => {
  const requested = parseUrl(requestedUrl)
  const fetched = parseUrl(fetchedUrl)
  if (requested.origin !== fetched.origin) {
    throw new Error(
      `隔離プロセスが異なるオリジンの URL を返しました (requested: ${requested.origin}, fetched: ${fetched.origin})`
    )
  }
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

const parseCodexFetchOutput = (text: string): CodexFetchOutput => {
  const parsed = parseJsonStrict(text, 'Codex の最終メッセージが JSON ではありません')
  if (!isRecord(parsed)) {
    throw new Error('Codex の最終メッセージが JSON オブジェクトではありません')
  }
  return {
    error_message: validateString(parsed.error_message, 'error_message'),
    fetch_success: validateBoolean(parsed.fetch_success, 'fetch_success'),
    raw_text: validateString(parsed.raw_text, 'raw_text'),
    url: validateString(parsed.url, 'url'),
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

export const extractRawText = (jsonl: string): CodexFetchOutput => {
  const events = parseJsonlEvents(jsonl)
  const lastMessage = findLastAgentMessage(events)
  if (typeof lastMessage !== 'string') {
    return handleMissingMessage(events)
  }
  const output = parseCodexFetchOutput(lastMessage)
  if (!output.fetch_success) {
    throw new Error(`Codex fetch が失敗しました: ${output.error_message}`)
  }
  return output
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
  const [requestedUrl] = process.argv.slice(2)
  if (typeof requestedUrl !== 'string' || requestedUrl.length === 0) {
    throw new Error('Usage: pipe-sanitize-codex.ts <URL>')
  }
  validateCliUrl(requestedUrl)
  const input = await readStdin()
  const { raw_text: rawText, url: fetchedUrl } = extractRawText(input)
  validateUrlOriginMatch(requestedUrl, fetchedUrl)
  process.stdout.write(`${JSON.stringify(sanitize(requestedUrl, fetchedUrl, rawText))}\n`)
}

/**
 * MARK: In-Source Testing
 * @example vp test .claude/skills/guarded-webfetch-codex/scripts/pipe-sanitize-codex.ts
 */

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('extractRawText', () => {
    it('Codex JSONL から最終 agent_message を抽出する', () => {
      const input = [
        '{"type":"thread.started"}',
        String.raw`{"type":"item.completed","item":{"type":"agent_message","text":"{\"url\":\"https://example.com\",\"raw_text\":\"hello\",\"fetch_success\":true,\"error_message\":\"\"}"}}`,
      ].join('\n')
      const result = extractRawText(input)
      expect(result.url).toBe('https://example.com')
      expect(result.raw_text).toBe('hello')
      expect(result.fetch_success).toBe(true)
    })

    it('error イベントしかない場合は失敗させる', () => {
      const input = '{"type":"error","message":"boom"}'
      expect(() => extractRawText(input)).toThrow('boom')
    })
  })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${formatThrown(error)}\n`)
    process.exitCode = 1
  })
}
