import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

interface ReleaseView {
  body: string
  publishedAt: string
  tagName: string
  url: string
}

interface ReleaseArgs {
  notesPath: string
  tag: string
}

const shellQuote = (value: string): string => {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) {
    return value
  }
  return `'${value.replaceAll("'", String.raw`'\''`)}'`
}

const formatCommand = (command: string, args: string[]): string =>
  [command, ...args].map(shellQuote).join(' ')

const fail = (message: string): never => {
  throw new Error(message)
}

const run = (command: string, args: string[]): void => {
  process.stdout.write(`\n$ ${formatCommand(command, args)}\n`)
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: 'inherit' })
  if (result.status !== 0) {
    fail(`Command failed: ${formatCommand(command, args)}`)
  }
}

const capture = (command: string, args: string[]): string => {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (result.status !== 0) {
    fail(`Command failed: ${formatCommand(command, args)}`)
  }
  return result.stdout.trim()
}

const assertCleanWorktree = (): void => {
  const status = capture('git', ['status', '--short'])
  if (status !== '') {
    fail(`Working tree must be clean before release:\n${status}`)
  }
}

const assertTag = (tag: string): void => {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    fail(`Tag must be semver-like, for example v1.2.3: ${tag}`)
  }
}

const readNotes = (notesPath: string): string => {
  const resolved = path.resolve(REPO_ROOT, notesPath)
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    fail(`Release notes file not found: ${notesPath}`)
  }
  const notes = readFileSync(resolved, 'utf8').trim()
  if (notes === '') {
    fail(`Release notes file is empty: ${notesPath}`)
  }
  return notes
}

const assertMainIsPushed = (): string => {
  const branch = capture('git', ['branch', '--show-current'])
  if (branch !== 'main') {
    fail(`Release must run from main, current branch is: ${branch}`)
  }

  run('git', ['fetch', 'origin', 'main', '--tags'])

  const head = capture('git', ['rev-parse', 'HEAD'])
  const originMain = capture('git', ['rev-parse', 'origin/main'])
  if (head !== originMain) {
    fail(
      `HEAD must match origin/main before release:\nHEAD:        ${head}\norigin/main: ${originMain}`
    )
  }
  return head
}

const assertRemoteTagAbsent = (tag: string): void => {
  const remoteTag = capture('git', ['ls-remote', '--tags', 'origin', tag])
  if (remoteTag !== '') {
    fail(`Remote tag already exists: ${tag}`)
  }
}

const assertRemoteTagPointsTo = (tag: string, expectedCommit: string): void => {
  const remoteTag = capture('git', ['ls-remote', '--tags', 'origin', tag])
  const [actualCommit = ''] = remoteTag.split(/\s+/)
  if (actualCommit !== expectedCommit) {
    fail(`Remote tag ${tag} points to ${actualCommit}, expected ${expectedCommit}`)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const parseReleaseView = (value: unknown): ReleaseView => {
  if (isRecord(value)) {
    const { body } = value
    const { publishedAt } = value
    const { tagName } = value
    const { url } = value
    if (
      typeof body === 'string' &&
      typeof publishedAt === 'string' &&
      typeof tagName === 'string' &&
      typeof url === 'string'
    ) {
      return { body, publishedAt, tagName, url }
    }
  }
  return fail('Unexpected gh release view response')
}

const readRelease = (tag: string): ReleaseView => {
  const output = capture('gh', ['release', 'view', tag, '--json', 'body,publishedAt,tagName,url'])
  const parsed: unknown = JSON.parse(output)
  return parseReleaseView(parsed)
}

const assertReleaseNotes = (tag: string, expectedNotes: string): ReleaseView => {
  const release = readRelease(tag)
  if (release.body.trim() !== expectedNotes) {
    fail(`Release notes were not applied to ${tag}`)
  }
  return release
}

const parseArgs = (): ReleaseArgs => {
  const [tag, notesPath] = process.argv.slice(2)
  if (typeof tag !== 'string' || typeof notesPath !== 'string') {
    fail('Usage: npm run release-skill -- <vX.Y.Z> <release-notes.md>')
  }
  return { notesPath, tag }
}

const runPreflight = ({ notesPath, tag }: ReleaseArgs): { head: string; notes: string } => {
  assertTag(tag)
  const notes = readNotes(notesPath)
  assertCleanWorktree()
  const head = assertMainIsPushed()
  assertRemoteTagAbsent(tag)
  return { head, notes }
}

const publish = ({ notesPath, tag }: ReleaseArgs, head: string, notes: string): ReleaseView => {
  run('vp', ['check'])
  run('vp', ['test'])
  run('gh', ['skill', 'publish', '--dry-run'])
  run('gh', ['skill', 'publish', '--tag', tag])
  assertRemoteTagPointsTo(tag, head)
  run('gh', ['release', 'edit', tag, '--notes-file', notesPath])
  return assertReleaseNotes(tag, notes)
}

const main = (): void => {
  const args = parseArgs()
  const { head, notes } = runPreflight(args)
  const release = publish(args, head, notes)

  process.stdout.write(`\nPublished ${release.tagName}: ${release.url}\n`)
  process.stdout.write(`Published at: ${release.publishedAt}\n`)
}

try {
  main()
} catch (error: unknown) {
  let message = String(error)
  if (error instanceof Error) {
    ;({ message } = error)
  }
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}
