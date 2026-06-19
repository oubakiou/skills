/**
 * shared/ の正本を各 skill の scripts/ にコピーする同期ツール。
 *
 * 各 guarded 系 skill は self-contained を保つため scripts/ に正本のコピーを持つ。
 * このスクリプトはそのコピーを正本から自動生成 / 検証する。
 *
 * @example
 *   node scripts/sync-shared.ts          # 正本から各コピーを上書き
 *   node scripts/sync-shared.ts --check  # コピーが正本と一致するか検証 (pre-commit 用)
 */

import path from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

interface SyncEntry {
  /** 正本パス (リポジトリルートからの相対) */
  source: string
  /** 配布先パス (リポジトリルートからの相対) */
  targets: string[]
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const ENTRIES: SyncEntry[] = [
  {
    source: 'shared/sanitize/sanitize.ts',
    targets: [
      'skills/guarded-webfetch-claude/scripts/sanitize.ts',
      'skills/guarded-webfetch-codex/scripts/sanitize.ts',
      'skills/guarded-websearch-claude/scripts/sanitize.ts',
      'skills/guarded-websearch-codex/scripts/sanitize.ts',
    ],
  },
  {
    source: 'shared/codex-jsonl/codex-jsonl.ts',
    targets: [
      'skills/guarded-webfetch-codex/scripts/codex-jsonl.ts',
      'skills/guarded-websearch-codex/scripts/codex-jsonl.ts',
    ],
  },
]

const readSource = (source: string): string => readFileSync(path.resolve(REPO_ROOT, source), 'utf8')

const readTarget = (target: string): string | null => {
  try {
    return readFileSync(path.resolve(REPO_ROOT, target), 'utf8')
  } catch {
    return null
  }
}

interface CheckResult {
  drifted: string[]
  missing: string[]
  ok: string[]
}

const expandPairs = (): { source: string; target: string }[] =>
  ENTRIES.flatMap(({ source, targets }) => targets.map((target) => ({ source, target })))

const classify = (sourceContent: string, target: string): keyof CheckResult => {
  const targetContent = readTarget(target)
  if (targetContent === null) {
    return 'missing'
  }
  if (targetContent === sourceContent) {
    return 'ok'
  }
  return 'drifted'
}

const collectDiffs = (): CheckResult =>
  expandPairs().reduce<CheckResult>(
    (acc, { source, target }) => {
      const bucket = classify(readSource(source), target)
      acc[bucket].push(target)
      return acc
    },
    { drifted: [], missing: [], ok: [] }
  )

const writeAll = (): { updated: string[] } => {
  const updated = expandPairs().flatMap(({ source, target }) => {
    const sourceContent = readSource(source)
    const targetContent = readTarget(target)
    if (targetContent === sourceContent) {
      return []
    }
    writeFileSync(path.resolve(REPO_ROOT, target), sourceContent)
    return [target]
  })
  return { updated }
}

const formatList = (paths: string[]): string => paths.map((entry) => `  - ${entry}`).join('\n')

const runCheck = (): void => {
  const { drifted, missing } = collectDiffs()
  if (drifted.length === 0 && missing.length === 0) {
    process.stdout.write('shared/ と各 skill のコピーは一致しています。\n')
    return
  }
  if (missing.length > 0) {
    process.stderr.write(`コピー先ファイルが見つかりません:\n${formatList(missing)}\n`)
  }
  if (drifted.length > 0) {
    process.stderr.write(`コピーが正本とズレています:\n${formatList(drifted)}\n`)
  }
  process.stderr.write("'npm run sync-shared' を実行して同期してください。\n")
  process.exitCode = 1
}

const runSync = (): void => {
  const { updated } = writeAll()
  if (updated.length === 0) {
    process.stdout.write('変更なし。すべてのコピーは既に正本と一致しています。\n')
    return
  }
  process.stdout.write(`${updated.length} 件のコピーを更新しました:\n${formatList(updated)}\n`)
}

const main = (): void => {
  if (process.argv.includes('--check')) {
    runCheck()
    return
  }
  runSync()
}

main()
