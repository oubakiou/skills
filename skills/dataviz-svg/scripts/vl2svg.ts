import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compile } from 'vega-lite'
import { loader, logger, parse, View, Warn } from 'vega'

const isCliEntry = (): boolean => {
  const [, entryPath] = process.argv
  if (typeof entryPath !== 'string') {
    return false
  }
  return import.meta.url === pathToFileURL(entryPath).href
}

const isDelegatedUrl = (uri: string): boolean => {
  try {
    const url = new URL(uri)
    return url.protocol !== 'file:'
  } catch {
    return uri.startsWith('//')
  }
}

const resolveLocalDataPath = (uri: string, base: string): string => {
  if (uri.startsWith('file://')) {
    return fileURLToPath(uri)
  }
  if (path.isAbsolute(uri)) {
    return uri
  }
  return path.resolve(base, uri)
}

const createDataLoader = (base: string): ReturnType<typeof loader> => {
  const delegatedLoader = loader({ baseURL: base })
  return {
    ...delegatedLoader,
    async load(uri, options) {
      if (isDelegatedUrl(uri)) {
        return delegatedLoader.load(uri, options)
      }
      return readFileSync(resolveLocalDataPath(uri, base), 'utf8')
    },
  }
}

export const renderSvg = async (specPath: string, outputPath: string): Promise<void> => {
  const specFile = path.resolve(specPath)
  const vlSpec = JSON.parse(readFileSync(specFile, 'utf8'))
  const base = path.dirname(specFile)

  const vgSpec = compile(vlSpec).spec
  const view = new View(parse(vgSpec), {
    loader: createDataLoader(base),
    logger: logger(Warn, 'error'),
    renderer: 'none',
  }).finalize()

  const svg = await view.toSVG()

  const outDir = path.dirname(path.resolve(outputPath))
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.resolve(outputPath), svg)
}

const runCli = async (): Promise<void> => {
  const [specPath, outputPath] = process.argv.slice(2)

  if (!specPath || !outputPath) {
    throw new Error('Usage: node vl2svg.mjs <spec.json> <output.svg>')
  }

  await renderSvg(specPath, outputPath)
  process.stdout.write(`SVG generated: ${outputPath}\n`)
}

if (isCliEntry()) {
  await runCli().catch((error: unknown) => {
    let message = String(error)
    if (error instanceof Error) {
      ;({ message } = error)
    }
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}

const testDir = (name: string): string => {
  const dir = path.resolve('.temp', 'dataviz-svg-tests', name)
  mkdirSync(dir, { recursive: true })
  return dir
}

const barSpec = (dataSpec: string): string => `{
  "$schema": "https://vega.github.io/schema/vega-lite/v5.json",
  "width": 200,
  "height": 120,
  "data": ${dataSpec},
  "mark": "bar",
  "encoding": {
    "x": { "field": "category", "type": "nominal" },
    "y": { "field": "value", "type": "quantitative" }
  }
}`

const writeRelativeCsvFixture = (dir: string, specPath: string): void => {
  mkdirSync(path.join(dir, 'data'), { recursive: true })
  writeFileSync(path.join(dir, 'data', 'sales.csv'), 'category,value\nA,1\nB,2\n')
  writeFileSync(specPath, barSpec('{ "url": "data/sales.csv", "format": { "type": "csv" } }'))
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('renderSvg', () => {
    it('インラインデータから SVG を生成する', async () => {
      const dir = testDir('inline')
      const specPath = path.join(dir, 'chart.vl.json')
      const outputPath = path.join(dir, 'out.svg')
      writeFileSync(specPath, barSpec('{ "values": [{ "category": "A", "value": 1 }] }'))

      await renderSvg(specPath, outputPath)

      expect(readFileSync(outputPath, 'utf8')).toContain('<svg')
    })

    it('spec からの相対パスで CSV を読み込む', async () => {
      const dir = testDir('relative-csv')
      const specPath = path.join(dir, 'chart.vl.json')
      const outputPath = path.join(dir, 'out.svg')
      writeRelativeCsvFixture(dir, specPath)

      await renderSvg(specPath, outputPath)

      const svg = readFileSync(outputPath, 'utf8')
      expect(svg).toContain('<svg')
      expect(svg).toContain('A')
      expect(svg).toContain('B')
    })

    it('存在しない spec は失敗する', async () => {
      const dir = testDir('missing-spec')
      await expect(
        renderSvg(path.join(dir, 'missing.vl.json'), path.join(dir, 'out.svg'))
      ).rejects.toThrow()
    })

    it('出力ディレクトリを作成する', async () => {
      const dir = testDir('nested-output')
      const specPath = path.join(dir, 'chart.vl.json')
      const outputPath = path.join(dir, 'assets', 'charts', 'out.svg')
      writeFileSync(specPath, barSpec('{ "values": [{ "category": "A", "value": 1 }] }'))

      await renderSvg(specPath, outputPath)

      expect(readFileSync(outputPath, 'utf8')).toContain('<svg')
    })
  })
}
