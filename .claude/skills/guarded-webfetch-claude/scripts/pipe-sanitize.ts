/**
 * 隔離プロセスの JSON 出力を stdin から読み、sanitize して stdout に出力するパイプスクリプト
 * 隔離プロセス (claude -p) の出力をパイプで受け取り、生テキストが main agent に入ることを防ぐ
 * @example claude -p [fetch flags] "prompt" | node pipe-sanitize.ts "<url>"
 */

import { realpathSync } from 'node:fs'

import { sanitize } from './sanitize.ts'

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
): { requested: URL; fetched: URL } => {
  try {
    return { fetched: new URL(fetchedUrl), requested: new URL(requestedUrl) }
  } catch {
    throw new Error(
      `URL のオリジン比較に失敗しました (requested: ${requestedUrl}, fetched: ${fetchedUrl})`
    )
  }
}

/**
 * CLI 引数の URL を検証する。http: または https: のみ許可
 * @throws 不正なプロトコルまたはパース失敗時
 */
export const validateCliUrl = (url: string): void => {
  const parsed = parseUrl(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `URL のプロトコルが不正です (${parsed.protocol}). http: または https: のみ許可されます`
    )
  }
}

/**
 * 要求 URL と隔離プロセスが返した URL のオリジン（scheme + host + port）を比較する。
 * 不一致の場合はエラーを投げる（fail-closed: 隔離プロセスが別のサイトを fetch した可能性）。
 * 同一オリジン内のパス差異（リダイレクト等）は許容する。
 */
export const validateUrlOriginMatch = (requestedUrl: string, fetchedUrl: string): void => {
  const { requested, fetched } = parseUrlPair(requestedUrl, fetchedUrl)
  if (requested.origin !== fetched.origin) {
    throw new Error(
      `隔離プロセスが異なるオリジンの URL を返しました (requested: ${requested.origin}, fetched: ${fetched.origin}). コンテンツの出所が要求と一致しないため処理を中止します`
    )
  }
}

/** 値がオブジェクトかどうか判定する型ガード */
const isRecord = (val: unknown): val is Record<string, unknown> =>
  typeof val === 'object' && val !== null && !Array.isArray(val)

/** 隔離プロセスのラッパー形式を検証し structured_output を返す */
const validateEnvelope = (data: unknown): Record<string, unknown> => {
  if (!isRecord(data)) {
    throw new Error('入力が JSON オブジェクトではありません')
  }
  if (data.subtype !== 'success') {
    throw new Error(`隔離プロセスが失敗しました (subtype: ${String(data.subtype)})`)
  }
  if (!isRecord(data.structured_output)) {
    throw new Error('structured_output が存在しないか、オブジェクトではありません')
  }
  return data.structured_output
}

/** structured_output.error_message が文字列の場合はそれを、それ以外は汎用エラー文を返す */
const formatErrorMessage = (output: Record<string, unknown>): string => {
  if (typeof output.error_message === 'string') {
    return output.error_message
  }
  return '不明なエラー'
}

/** fetch_success フラグを検証し、失敗時は error_message を含むエラーを投げる */
const checkFetchSuccess = (output: Record<string, unknown>): void => {
  if (typeof output.fetch_success !== 'boolean') {
    throw new Error(
      `structured_output.fetch_success が boolean ではありません (${typeof output.fetch_success})`
    )
  }
  if (!output.fetch_success) {
    throw new Error(`WebFetch が失敗しました: ${formatErrorMessage(output)}`)
  }
}

/**
 * claude -p --output-format json の出力ラッパーから raw_text を抽出する
 * ラッパー形式: { subtype: "success", structured_output: { url, raw_text, fetch_success, ... }, ... }
 */
export const extractRawText = (data: unknown): { url: string; rawText: string } => {
  const output = validateEnvelope(data)
  checkFetchSuccess(output)
  if (typeof output.raw_text !== 'string') {
    throw new Error('structured_output.raw_text が文字列ではありません')
  }
  if (typeof output.url !== 'string') {
    throw new Error('structured_output.url が文字列ではありません')
  }
  return { rawText: output.raw_text, url: output.url }
}

/**
 * MARK: In-Source Testing
 * @example vp test .claude/skills/guarded-webfetch-claude/scripts/pipe-sanitize.ts
 */

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest

  describe('extractRawText', () => {
    describe('正常系', () => {
      it('正常な隔離プロセス出力から raw_text を抽出する', () => {
        const input = {
          structured_output: {
            fetch_success: true,
            raw_text: 'Hello World',
            url: 'https://example.com',
          },
          subtype: 'success',
        }
        const result = extractRawText(input)
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
        expect(() => extractRawText(JSON.parse('null'))).toThrow('JSON オブジェクト')
      })
    })

    describe('ラッパー検証', () => {
      it('subtype が success でない場合にエラーを投げる', () => {
        const input = {
          structured_output: { fetch_success: true, raw_text: 'text', url: 'https://example.com' },
          subtype: 'error',
        }
        expect(() => extractRawText(input)).toThrow('隔離プロセスが失敗しました')
      })

      it('structured_output が存在しない場合にエラーを投げる', () => {
        const input = { subtype: 'success' }
        expect(() => extractRawText(input)).toThrow('structured_output')
      })

      it('structured_output が配列の場合にエラーを投げる', () => {
        const input = { structured_output: [1, 2], subtype: 'success' }
        expect(() => extractRawText(input)).toThrow('structured_output が存在しないか')
      })
    })

    describe('fetch_success 検証', () => {
      it('fetch_success が false の場合にエラーを投げる', () => {
        const input = {
          structured_output: {
            error_message: '404 Not Found',
            fetch_success: false,
            raw_text: '',
            url: 'https://example.com',
          },
          subtype: 'success',
        }
        expect(() => extractRawText(input)).toThrow('404 Not Found')
      })

      it('fetch_success が boolean でない場合にエラーを投げる', () => {
        const input = {
          structured_output: {
            fetch_success: 'true',
            raw_text: 'text',
            url: 'https://example.com',
          },
          subtype: 'success',
        }
        expect(() => extractRawText(input)).toThrow('fetch_success が boolean ではありません')
      })

      it('fetch_success が undefined の場合にエラーを投げる', () => {
        const input = {
          structured_output: {
            raw_text: 'text',
            url: 'https://example.com',
          },
          subtype: 'success',
        }
        expect(() => extractRawText(input)).toThrow('fetch_success が boolean ではありません')
      })

      it('fetch_success が false で error_message がない場合に汎用エラーを投げる', () => {
        const input = {
          structured_output: {
            fetch_success: false,
            raw_text: '',
            url: 'https://example.com',
          },
          subtype: 'success',
        }
        expect(() => extractRawText(input)).toThrow('不明なエラー')
      })
    })

    describe('内容検証', () => {
      it('raw_text が文字列でない場合にエラーを投げる', () => {
        const input = {
          structured_output: { fetch_success: true, raw_text: 42, url: 'https://example.com' },
          subtype: 'success',
        }
        expect(() => extractRawText(input)).toThrow('raw_text が文字列ではありません')
      })

      it('url が文字列でない場合にエラーを投げる', () => {
        const input = {
          structured_output: { fetch_success: true, raw_text: 'text', url: 123 },
          subtype: 'success',
        }
        expect(() => extractRawText(input)).toThrow('url が文字列ではありません')
      })
    })
  })

  describe('validateCliUrl', () => {
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

  describe('validateUrlOriginMatch', () => {
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

    it('異なるオリジンの URL を拒否する', () => {
      expect(() => validateUrlOriginMatch('https://example.com', 'https://malicious.com')).toThrow(
        '異なるオリジン'
      )
    })

    it('スキームが異なる URL を拒否する', () => {
      expect(() => validateUrlOriginMatch('https://example.com', 'http://example.com')).toThrow(
        '異なるオリジン'
      )
    })

    it('ポートが異なる URL を拒否する', () => {
      expect(() =>
        validateUrlOriginMatch('https://example.com', 'https://example.com:8080')
      ).toThrow('異なるオリジン')
    })

    it('パース不能な URL でエラーを投げる', () => {
      expect(() => validateUrlOriginMatch('not-a-url', 'https://example.com')).toThrow(
        'オリジン比較に失敗'
      )
    })
  })

  describe('パイプライン統合テスト', () => {
    it('正常な入力をサニタイズして出力する', () => {
      const input = {
        structured_output: {
          fetch_success: true,
          raw_text: 'Normal text with <|im_start|> injection',
          url: 'https://example.com',
        },
        subtype: 'success',
      }
      const { url, rawText } = extractRawText(input)
      const result = sanitize(url, url, rawText)
      expect(result.requested_url).toBe('https://example.com')
      expect(result.fetched_url).toBe('https://example.com')
      expect(result.text).toContain('[FILTERED:chat_template]')
      expect(result.text).not.toContain('<|im_start|>')
      expect(result.flags.suspicious_patterns.length).toBeGreaterThan(0)
    })

    it('隔離プロセスが異なるオリジンの URL を返した場合にエラーを投げる', () => {
      const input = {
        structured_output: {
          fetch_success: true,
          raw_text: 'safe content',
          url: 'https://malicious.com',
        },
        subtype: 'success',
      }
      const { url: fetchedUrl } = extractRawText(input)
      const cliUrl = 'https://example.com'
      expect(() => validateUrlOriginMatch(cliUrl, fetchedUrl)).toThrow('異なるオリジン')
    })

    it('同一オリジン内のリダイレクトを許容し両URLを保持する', () => {
      const input = {
        structured_output: {
          fetch_success: true,
          raw_text: 'content',
          url: 'https://example.com/redirected',
        },
        subtype: 'success',
      }
      const { url: fetchedUrl, rawText } = extractRawText(input)
      const cliUrl = 'https://example.com/original'
      validateUrlOriginMatch(cliUrl, fetchedUrl)
      const result = sanitize(cliUrl, fetchedUrl, rawText)
      expect(result.requested_url).toBe('https://example.com/original')
      expect(result.fetched_url).toBe('https://example.com/redirected')
    })

    it('不可視Unicode文字を含むテキストをサニタイズする', () => {
      const input = {
        structured_output: {
          fetch_success: true,
          raw_text: 'text\u{E0069}\u{E0067}\u200Bmore',
          url: 'https://example.com',
        },
        subtype: 'success',
      }
      const { url, rawText } = extractRawText(input)
      const result = sanitize(url, url, rawText)
      expect(result.text).toBe('textmore')
      expect(result.flags.had_invisible_chars).toBe(true)
    })
  })
}

// ---------- CLI ----------
const isEntryFile = (): boolean => {
  const [, entryPath] = process.argv
  if (!entryPath) {
    return false
  }
  return import.meta.url === `file://${realpathSync(entryPath)}`
}

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error('JSON パースに失敗しました')
  }
}

const formatThrown = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

/** stdin を全て読み取り、UTF-8 文字列にトリムして返す */
const readStdinTrim = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

/** JSON.stringify は replacer に null/undefined を直接渡せない（eslint 規則）ため恒等 replacer を経由する */
const writeJsonOutput = (value: unknown): void => {
  const INDENT = 2
  const json = JSON.stringify(value, (_key, val: unknown) => val, INDENT)
  process.stdout.write(`${json}\n`)
}

/** stdin から JSON を読み、隔離プロセス出力ラッパーを検証して raw_text を取り出す */
const readEnvelope = async (): Promise<{ url: string; rawText: string }> => {
  const raw = await readStdinTrim()
  if (!raw) {
    throw new Error('stdin が空です')
  }
  return extractRawText(parseJson(raw))
}

const runCli = async (): Promise<void> => {
  const { url: fetchedUrl, rawText } = await readEnvelope()
  const [cliUrl] = process.argv.slice(2)
  if (cliUrl) {
    validateCliUrl(cliUrl)
    // オリジン不一致は fail-closed（隔離プロセスが別サイトを fetch した可能性）
    validateUrlOriginMatch(cliUrl, fetchedUrl)
  }
  const requestedUrl = cliUrl || fetchedUrl
  const result = sanitize(requestedUrl, fetchedUrl, rawText)
  writeJsonOutput(result)
}

if (isEntryFile()) {
  try {
    await runCli()
  } catch (error) {
    process.stderr.write(`ERROR: ${formatThrown(error)}\n`)
    process.exitCode = 1
  }
}
