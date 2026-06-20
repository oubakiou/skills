/**
 * サニタイズ済み JSON に子 Codex の要約を追加する。
 * 要約だけを sanitize() に通し、既存 flags とマージして出力する。
 * @example node merge-summary-codex.ts <summary_file> < sanitized.json
 */

import { closeSync, openSync, readSync } from 'node:fs'

import { MAX_STDIN_BYTES, mergeFlags, readStdin } from './pipe-sanitize-codex.ts'
import { sanitize } from './sanitize.ts'

interface SanitizedFlags {
  had_invisible_chars: boolean
  suspicious_patterns: Record<string, number>
  truncated: boolean
}

interface SanitizedMeta {
  raw_char_length: number
  sanitized_at: string
}

interface SanitizedInput {
  fetched_url: string
  flags: SanitizedFlags
  meta: SanitizedMeta
  raw_html: string
  raw_text: string
  requested_url: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requireString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new Error(`sanitized JSON の ${key} が文字列ではありません`)
  }
  return value
}

const numberOrZero = (value: unknown): number => {
  if (typeof value === 'number') {
    return value
  }
  return 0
}

const stringOrEmpty = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  return ''
}

const extractSuspiciousPatterns = (value: unknown): Record<string, number> => {
  if (!isRecord(value)) {
    return {}
  }
  const result: Record<string, number> = {}
  for (const [key, count] of Object.entries(value)) {
    if (typeof count === 'number') {
      result[key] = count
    }
  }
  return result
}

const validateFlags = (record: Record<string, unknown>): SanitizedFlags => {
  const { flags } = record
  if (!isRecord(flags)) {
    throw new Error('sanitized JSON の flags がオブジェクトではありません')
  }
  return {
    had_invisible_chars: flags.had_invisible_chars === true,
    suspicious_patterns: extractSuspiciousPatterns(flags.suspicious_patterns),
    truncated: flags.truncated === true,
  }
}

const validateMeta = (record: Record<string, unknown>): SanitizedMeta => {
  const { meta } = record
  if (!isRecord(meta)) {
    throw new Error('sanitized JSON の meta がオブジェクトではありません')
  }
  return {
    raw_char_length: numberOrZero(meta.raw_char_length),
    sanitized_at: stringOrEmpty(meta.sanitized_at),
  }
}

const parseSanitizedJson = (text: string): SanitizedInput => {
  const parsed = JSON.parse(text) as unknown
  if (!isRecord(parsed)) {
    throw new Error('sanitized JSON がオブジェクトではありません')
  }
  return {
    fetched_url: requireString(parsed, 'fetched_url'),
    flags: validateFlags(parsed),
    meta: validateMeta(parsed),
    raw_html: requireString(parsed, 'raw_html'),
    raw_text: requireString(parsed, 'raw_text'),
    requested_url: requireString(parsed, 'requested_url'),
  }
}

export const MAX_SUMMARY_BYTES = 40_000

const readSummaryFile = (filePath: string, maxBytes: number = MAX_SUMMARY_BYTES): string => {
  try {
    const fd = openSync(filePath, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes)
      const bytesRead = readSync(fd, buffer, 0, maxBytes, 0)
      return buffer.toString('utf8', 0, bytesRead).trim()
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

const existingFlagsAsResult = (
  flags: SanitizedFlags,
  requestedUrl: string,
  fetchedUrl: string
): ReturnType<typeof sanitize> => ({
  fetched_url: fetchedUrl,
  flags: {
    had_invisible_chars: flags.had_invisible_chars,
    suspicious_patterns: { ...flags.suspicious_patterns },
    truncated: flags.truncated,
  },
  meta: { raw_char_length: 0, sanitized_at: '' },
  requested_url: requestedUrl,
  text: '',
})

const isSummaryMissing = (rawText: string, summaryText: string): boolean =>
  rawText.trim().length > 0 && summaryText.trim().length === 0

interface MergeResult {
  json: string
  summaryMissing: boolean
}

export const mergeSummary = (sanitizedJson: string, summaryText: string): MergeResult => {
  const input = parseSanitizedJson(sanitizedJson)
  const summaryResult = sanitize(input.requested_url, input.fetched_url, summaryText)
  const existingResult = existingFlagsAsResult(input.flags, input.requested_url, input.fetched_url)
  const summaryMissing = isSummaryMissing(input.raw_text, summaryText)
  const json = JSON.stringify({
    fetched_url: input.fetched_url,
    flags: mergeFlags(existingResult, summaryResult),
    meta: input.meta,
    raw_html: input.raw_html,
    raw_text: input.raw_text,
    requested_url: input.requested_url,
    summary: summaryResult.text,
    summary_missing: summaryMissing,
  })
  return { json, summaryMissing }
}

const formatErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

const parseCliArgs = (): string => {
  const [summaryFilePath] = process.argv.slice(2)
  if (typeof summaryFilePath !== 'string' || summaryFilePath.length === 0) {
    throw new Error('Usage: merge-summary-codex.ts <summary_file>')
  }
  return summaryFilePath
}

const readAndValidateStdin = async (): Promise<string> => {
  const sanitizedJson = await readStdin(process.stdin, MAX_STDIN_BYTES)
  if (sanitizedJson.trim().length === 0) {
    throw new Error('stdin が空です')
  }
  return sanitizedJson
}

const main = async (): Promise<void> => {
  const summaryFilePath = parseCliArgs()
  const sanitizedJson = await readAndValidateStdin()
  const summaryText = readSummaryFile(summaryFilePath)
  const result = mergeSummary(sanitizedJson, summaryText)
  if (result.summaryMissing) {
    process.stderr.write('WARNING: raw_text は非空ですが summary.txt が生成されませんでした\n')
  }
  process.stdout.write(`${result.json}\n`)
}

const buildSanitizedJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    fetched_url: 'https://example.com',
    flags: { had_invisible_chars: false, suspicious_patterns: {}, truncated: false },
    meta: { raw_char_length: 100, sanitized_at: '2026-01-01T00:00:00.000Z' },
    raw_html: '<html>content</html>',
    raw_text: 'content',
    requested_url: 'https://example.com',
    ...overrides,
  })

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('mergeSummary', () => {
    it('要約を追加して出力する', () => {
      const result = mergeSummary(buildSanitizedJson(), '日本語の要約テキスト')
      expect(result.json).toContain('"summary":"日本語の要約テキスト"')
      expect(result.json).toContain('"raw_text":"content"')
      expect(result.json).toContain('"raw_html":"<html>content</html>"')
      expect(result.summaryMissing).toBe(false)
    })

    it('空の要約でも正常に出力する', () => {
      const result = mergeSummary(buildSanitizedJson(), '')
      expect(result.json).toContain('"summary":""')
    })

    it('要約内の LLM マーカーをサニタイズする', () => {
      const result = mergeSummary(buildSanitizedJson(), 'summary <|im_start|> text')
      expect(result.json).toContain('[FILTERED:chat_template]')
      expect(result.json).not.toContain('<|im_start|>')
    })

    it('要約の flags を既存 flags にマージする', () => {
      const input = buildSanitizedJson({
        flags: {
          had_invisible_chars: false,
          suspicious_patterns: { chat_template: 2 },
          truncated: false,
        },
      })
      const result = mergeSummary(input, 'summary <|im_start|> text')
      expect(result.json).toContain('"chat_template":3')
    })

    it('要約にのみ不可視文字がある場合も flags に反映される', () => {
      const result = mergeSummary(buildSanitizedJson(), 'summary\u{E0069}text')
      expect(result.json).toContain('"had_invisible_chars":true')
    })

    it('既存の had_invisible_chars が true なら要約が clean でも true を維持する', () => {
      const input = buildSanitizedJson({
        flags: { had_invisible_chars: true, suspicious_patterns: {}, truncated: false },
      })
      const result = mergeSummary(input, 'clean summary')
      expect(result.json).toContain('"had_invisible_chars":true')
    })

    it('raw_text が非空で要約が空なら summaryMissing が true になる', () => {
      const result = mergeSummary(buildSanitizedJson({ raw_text: 'non-empty' }), '')
      expect(result.summaryMissing).toBe(true)
      expect(result.json).toContain('"summary_missing":true')
    })

    it('raw_text が空なら要約が空でも summaryMissing は false になる', () => {
      const result = mergeSummary(buildSanitizedJson({ raw_text: '' }), '')
      expect(result.summaryMissing).toBe(false)
      expect(result.json).toContain('"summary_missing":false')
    })
  })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${formatErrorMessage(error)}\n`)
    process.exitCode = 1
  })
}
