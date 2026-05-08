/**
 * Codex CLI の `--json` 出力 (JSONL イベント列) から最終 agent_message を抽出する共通ユーティリティ。
 *
 * 正本: shared/codex-jsonl/codex-jsonl.ts
 * webfetch-codex / websearch-codex の scripts/codex-jsonl.ts は scripts/sync-shared.ts により
 * この正本から自動生成されたコピー。編集は正本に対して行うこと。
 */

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

/**
 * JSONL から最終 agent_message のテキストを取り出す。
 * agent_message が見つからない場合、error イベントがあればそのメッセージを含めて throw し、
 * それも無ければ汎用エラーで throw する (fail-closed)。
 */
export const extractLastAgentMessage = (jsonl: string): string => {
  const events = parseJsonlEvents(jsonl)
  const lastMessage = findLastAgentMessage(events)
  if (typeof lastMessage === 'string') {
    return lastMessage
  }
  const lastError = findLastErrorMessage(events)
  if (typeof lastError === 'string') {
    throw new Error(`Codex 子プロセスが失敗しました: ${lastError}`)
  }
  throw new Error('Codex 子プロセスの最終 agent_message が見つかりません')
}

/**
 * MARK: In-Source Testing
 * @example vp test shared/codex-jsonl/codex-jsonl.ts
 */

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('extractLastAgentMessage', () => {
    it('Codex JSONL から最終 agent_message を抽出する', () => {
      const input = [
        '{"type":"thread.started"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}',
      ].join('\n')
      expect(extractLastAgentMessage(input)).toBe('hello')
    })

    it('複数の agent_message があれば最後のものを返す', () => {
      const input = [
        '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}',
      ].join('\n')
      expect(extractLastAgentMessage(input)).toBe('second')
    })

    it('JSON として解釈できない行は無視する', () => {
      const input = [
        'not a json line',
        '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
      ].join('\n')
      expect(extractLastAgentMessage(input)).toBe('ok')
    })

    it('error イベントしかない場合はそのメッセージを含めて throw する', () => {
      const input = '{"type":"error","message":"boom"}'
      expect(() => extractLastAgentMessage(input)).toThrow('boom')
    })

    it('agent_message も error も無ければ汎用エラーで throw する', () => {
      const input = '{"type":"thread.started"}'
      expect(() => extractLastAgentMessage(input)).toThrow('agent_message が見つかりません')
    })

    it('空入力でも throw する (fail-closed)', () => {
      expect(() => extractLastAgentMessage('')).toThrow('agent_message が見つかりません')
    })
  })
}
