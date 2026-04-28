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
  item?: {
    text?: string
    type?: string
  }
  type?: string
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
  if (!isRecord(value)) {
    return false
  }
  if (value.type !== 'item.completed') {
    return false
  }
  if (!isRecord(value.item)) {
    return false
  }
  return value.item.type === 'agent_message' && typeof value.item.text === 'string'
}

const parseCodexFetchOutput = (text: string): CodexFetchOutput => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Codex の最終メッセージが JSON ではありません')
  }
  if (!isRecord(parsed)) {
    throw new Error('Codex の最終メッセージが JSON オブジェクトではありません')
  }
  if (typeof parsed.url !== 'string') {
    throw new Error('Codex 出力の url が文字列ではありません')
  }
  if (typeof parsed.raw_text !== 'string') {
    throw new Error('Codex 出力の raw_text が文字列ではありません')
  }
  if (typeof parsed.fetch_success !== 'boolean') {
    throw new Error('Codex 出力の fetch_success が boolean ではありません')
  }
  if (typeof parsed.error_message !== 'string') {
    throw new Error('Codex 出力の error_message が文字列ではありません')
  }
  return {
    error_message: parsed.error_message,
    fetch_success: parsed.fetch_success,
    raw_text: parsed.raw_text,
    url: parsed.url,
  }
}

export const extractRawText = (jsonl: string): CodexFetchOutput => {
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

  const output = parseCodexFetchOutput(lastMessage)
  if (!output.fetch_success) {
    throw new Error(`Codex fetch が失敗しました: ${output.error_message}`)
  }
  return output
}

const main = async (): Promise<void> => {
  const requestedUrl = process.argv[2]
  if (typeof requestedUrl !== 'string' || requestedUrl.length === 0) {
    throw new Error('Usage: pipe-sanitize-codex.ts <URL>')
  }
  validateCliUrl(requestedUrl)

  let input = ''
  for await (const chunk of process.stdin) {
    input += String(chunk)
  }

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
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exit(1)
  })
}
