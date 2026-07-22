import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { OutputInfo, Sharp, SharpConstructor } from 'sharp'

// 同梱 wasm32 ビルド (scripts/vendor/node_modules/) を bare specifier で解決させるため、
// vendor/ 配下を基点にした require を使う。anchor.cjs は実在しない解決基点用パス
const vendorRequire = createRequire(new URL('vendor/anchor.cjs', import.meta.url))
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- CJS require の戻り値は any。実体は vendored sharp で、型は devDependencies の同一バージョン sharp を参照する
const sharp = vendorRequire('sharp') as SharpConstructor

type Color = string

interface ResizeOp {
  type: 'resize'
  width?: number
  height?: number
  fit?: 'contain' | 'cover' | 'fill' | 'inside' | 'outside'
  position?: string
  background?: Color
  withoutEnlargement?: boolean
}

interface CropOp {
  type: 'crop' | 'extract'
  left: number
  top: number
  width: number
  height: number
}

interface RotateOp {
  type: 'rotate'
  angle: number
  background?: Color
}

interface ExtendOp {
  type: 'extend'
  top?: number
  bottom?: number
  left?: number
  right?: number
  background?: Color
}

interface TrimOp {
  type: 'trim'
  threshold?: number
}

interface FlattenOp {
  type: 'flatten'
  background?: Color
}

interface BlurOp {
  type: 'blur'
  sigma?: number
}

interface SharpenOp {
  type: 'sharpen'
  sigma?: number
}

interface TintOp {
  type: 'tint'
  color: Color
}

interface ModulateOp {
  type: 'modulate'
  brightness?: number
  saturation?: number
  hue?: number
  lightness?: number
}

interface CompositeOp {
  type: 'composite'
  input: string
  left?: number
  top?: number
  gravity?:
    | 'north'
    | 'northeast'
    | 'east'
    | 'southeast'
    | 'south'
    | 'southwest'
    | 'west'
    | 'northwest'
    | 'centre'
    | 'center'
  blend?:
    | 'over'
    | 'multiply'
    | 'screen'
    | 'overlay'
    | 'darken'
    | 'lighten'
    | 'difference'
    | 'exclusion'
}

interface FormatOp {
  type: 'format'
  format: 'jpeg' | 'png' | 'webp' | 'avif' | 'gif' | 'tiff'
  quality?: number
  lossless?: boolean
  compressionLevel?: number
  effort?: number
  progressive?: boolean
}

type EditOp =
  | ResizeOp
  | CropOp
  | RotateOp
  | { type: 'flip' }
  | { type: 'flop' }
  | ExtendOp
  | TrimOp
  | FlattenOp
  | { type: 'grayscale' }
  | { type: 'negate' }
  | BlurOp
  | SharpenOp
  | TintOp
  | ModulateOp
  | CompositeOp
  | FormatOp

interface EditSpec {
  input: string
  output: string
  ops: EditOp[]
}

interface RawSpec {
  input?: unknown
  output?: unknown
  ops?: EditOp[]
}

const KNOWN_OP_TYPES = new Set([
  'resize',
  'crop',
  'extract',
  'rotate',
  'flip',
  'flop',
  'extend',
  'trim',
  'flatten',
  'grayscale',
  'negate',
  'blur',
  'sharpen',
  'tint',
  'modulate',
  'composite',
  'format',
])

class SpecError extends Error {
  public override name = 'SpecError'
}

interface RequiredField {
  field: string
  kind: 'number' | 'string'
}

const CROP_REQUIRED_FIELDS: RequiredField[] = [
  { field: 'left', kind: 'number' },
  { field: 'top', kind: 'number' },
  { field: 'width', kind: 'number' },
  { field: 'height', kind: 'number' },
]

// 欠落すると sharp 側で不可解な TypeError や暗黙の挙動変化 (rotate の EXIF 自動回転等) になる
// パラメータは、spec エラー (exit 2) として報告するためここで検証する
const REQUIRED_OP_FIELDS: Record<string, RequiredField[]> = {
  composite: [{ field: 'input', kind: 'string' }],
  crop: CROP_REQUIRED_FIELDS,
  extract: CROP_REQUIRED_FIELDS,
  format: [{ field: 'format', kind: 'string' }],
  rotate: [{ field: 'angle', kind: 'number' }],
  tint: [{ field: 'color', kind: 'string' }],
}

const fieldTypeOf = (op: unknown, field: string): string => {
  if (typeof op !== 'object' || op === null) {
    return 'undefined'
  }
  const entry = Object.entries(op).find(([key]) => key === field)
  if (!entry) {
    return 'undefined'
  }
  return typeof entry[1]
}

const assertRequiredFields = (op: EditOp): void => {
  const required = REQUIRED_OP_FIELDS[op.type] ?? []
  for (const { field, kind } of required) {
    if (fieldTypeOf(op, field) !== kind) {
      throw new SpecError(`op "${op.type}" requires ${kind} field "${field}"`)
    }
  }
}

const parseSpecText = (raw: string): RawSpec => {
  try {
    return JSON.parse(raw) ?? {}
  } catch (error) {
    throw new SpecError(`spec is not valid JSON: ${String(error)}`)
  }
}

const opTypeOf = (op: unknown): string => {
  if (typeof op === 'object' && op !== null && 'type' in op && typeof op.type === 'string') {
    return op.type
  }
  return ''
}

const assertKnownOps = (ops: EditOp[]): void => {
  for (const op of ops) {
    const opType = opTypeOf(op)
    if (!KNOWN_OP_TYPES.has(opType)) {
      throw new SpecError(
        `unknown op type: ${JSON.stringify(opType)}. Supported: ${[...KNOWN_OP_TYPES].join(', ')}`
      )
    }
    assertRequiredFields(op)
  }
}

const parseSpec = (raw: string): EditSpec => {
  const spec = parseSpecText(raw)
  if (typeof spec.input !== 'string' || spec.input === '') {
    throw new SpecError('spec.input must be a non-empty string (source image path)')
  }
  if (typeof spec.output !== 'string' || spec.output === '') {
    throw new SpecError('spec.output must be a non-empty string (output image path)')
  }
  const ops = spec.ops ?? []
  if (!Array.isArray(ops)) {
    throw new SpecError('spec.ops must be an array of operations')
  }
  assertKnownOps(ops)
  return { input: spec.input, ops, output: spec.output }
}

const applySharpen = (img: Sharp, op: SharpenOp): Sharp => {
  if (typeof op.sigma === 'number') {
    return img.sharpen({ sigma: op.sigma })
  }
  return img.sharpen()
}

const applyTrim = (img: Sharp, op: TrimOp): Sharp => {
  if (typeof op.threshold === 'number') {
    return img.trim({ threshold: op.threshold })
  }
  return img.trim()
}

type OpOf<Kind extends EditOp['type']> = Extract<EditOp, { type: Kind }>

const applyFilterOp = (
  img: Sharp,
  op: OpOf<
    'blur' | 'composite' | 'format' | 'grayscale' | 'modulate' | 'negate' | 'sharpen' | 'tint'
  >
): Sharp => {
  switch (op.type) {
    case 'grayscale': {
      return img.grayscale()
    }
    case 'negate': {
      return img.negate()
    }
    case 'blur': {
      return img.blur(op.sigma)
    }
    case 'sharpen': {
      return applySharpen(img, op)
    }
    case 'tint': {
      return img.tint(op.color)
    }
    case 'modulate': {
      return img.modulate(op)
    }
    case 'composite': {
      return img.composite([
        {
          blend: op.blend,
          gravity: op.gravity,
          input: path.resolve(op.input),
          left: op.left,
          top: op.top,
        },
      ])
    }
    default: {
      return img.toFormat(op.format, op)
    }
  }
}

const applyOp = (img: Sharp, op: EditOp): Sharp => {
  switch (op.type) {
    case 'resize': {
      return img.resize(op)
    }
    case 'crop':
    case 'extract': {
      return img.extract({ height: op.height, left: op.left, top: op.top, width: op.width })
    }
    case 'rotate': {
      return img.rotate(op.angle, { background: op.background })
    }
    case 'flip': {
      return img.flip()
    }
    case 'flop': {
      return img.flop()
    }
    case 'extend': {
      return img.extend({
        background: op.background,
        bottom: op.bottom,
        left: op.left,
        right: op.right,
        top: op.top,
      })
    }
    case 'trim': {
      return applyTrim(img, op)
    }
    case 'flatten': {
      return img.flatten({ background: op.background })
    }
    default: {
      return applyFilterOp(img, op)
    }
  }
}

export const editImage = async (
  specPath: string
): Promise<{ info: OutputInfo; spec: EditSpec }> => {
  if (!existsSync(specPath)) {
    throw new SpecError(`spec file not found: ${specPath}`)
  }
  const spec = parseSpec(readFileSync(specPath, 'utf8'))
  const outputPath = path.resolve(spec.output)
  mkdirSync(path.dirname(outputPath), { recursive: true })
  const img = spec.ops.reduce(applyOp, sharp(path.resolve(spec.input)))
  const info = await img.toFile(outputPath)
  return { info, spec }
}

export interface ImageInfo {
  format?: string
  hasAlpha?: boolean
  height?: number
  sizeBytes: number
  width?: number
}

export const imageInfo = async (imagePath: string): Promise<ImageInfo> => {
  const metadata = await sharp(path.resolve(imagePath)).metadata()
  return {
    format: metadata.format,
    hasAlpha: metadata.hasAlpha,
    height: metadata.height,
    sizeBytes: statSync(imagePath).size,
    width: metadata.width,
  }
}

const isCliEntry = (): boolean => {
  const [, entryPath] = process.argv
  if (typeof entryPath !== 'string') {
    return false
  }
  return import.meta.url === pathToFileURL(entryPath).href
}

const runInfoCli = async (imagePath: string | undefined): Promise<void> => {
  if (!imagePath) {
    throw new SpecError('Usage: node edit-image.ts --info <image>')
  }
  const info = await imageInfo(imagePath)
  process.stdout.write(`${JSON.stringify(info, null, 2)}\n`)
}

const runCli = async (): Promise<void> => {
  const args = process.argv.slice(2)
  if (args[0] === '--info') {
    await runInfoCli(args[1])
    return
  }
  const [specPath] = args
  if (!specPath || args.length !== 1) {
    throw new SpecError('Usage: node edit-image.ts <spec.json> | node edit-image.ts --info <image>')
  }
  const { info, spec } = await editImage(specPath)
  process.stdout.write(
    `Image written: ${spec.output} (${info.format} ${info.width}x${info.height}, ${info.size} bytes)\n`
  )
}

if (isCliEntry()) {
  await runCli().catch((error: unknown) => {
    let message = String(error)
    if (error instanceof Error) {
      ;({ message } = error)
    }
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
    if (error instanceof SpecError) {
      process.exitCode = 2
    }
  })
}

const testDir = (name: string): string => {
  const dir = path.resolve('.temp', 'imgedit-sharp-tests', name)
  mkdirSync(dir, { recursive: true })
  return dir
}

const writeFixturePng = async (filePath: string, width = 400, height = 300): Promise<void> => {
  await sharp({
    create: { background: '#dc503c', channels: 3, height, width },
  })
    .png()
    .toFile(filePath)
}

const writeSpec = (dir: string, spec: object): string => {
  const specPath = path.join(dir, 'spec.json')
  writeFileSync(specPath, JSON.stringify(spec))
  return specPath
}

if (import.meta.vitest) {
  const { describe, expect, it } = import.meta.vitest

  describe('editImage', () => {
    it('resize して出力拡張子から WebP に変換する', async () => {
      const dir = testDir('resize-webp')
      const inputPath = path.join(dir, 'input.png')
      const outputPath = path.join(dir, 'out.webp')
      await writeFixturePng(inputPath)
      const specPath = writeSpec(dir, {
        input: inputPath,
        ops: [{ type: 'resize', width: 200 }],
        output: outputPath,
      })

      const { info } = await editImage(specPath)

      expect(info.format).toBe('webp')
      expect(await imageInfo(outputPath)).toMatchObject({ format: 'webp', height: 150, width: 200 })
    })

    it('crop と format op を連結して適用する', async () => {
      const dir = testDir('crop-format')
      const inputPath = path.join(dir, 'input.png')
      const outputPath = path.join(dir, 'out.jpg')
      await writeFixturePng(inputPath)
      const specPath = writeSpec(dir, {
        input: inputPath,
        ops: [
          { height: 100, left: 10, top: 20, type: 'crop', width: 120 },
          { format: 'jpeg', quality: 70, type: 'format' },
        ],
        output: outputPath,
      })

      await editImage(specPath)

      expect(await imageInfo(outputPath)).toMatchObject({ format: 'jpeg', height: 100, width: 120 })
    })

    it('出力ディレクトリを自動作成する', async () => {
      const dir = testDir('nested-output')
      const inputPath = path.join(dir, 'input.png')
      const outputPath = path.join(dir, 'assets', 'images', 'out.png')
      await writeFixturePng(inputPath)
      const specPath = writeSpec(dir, {
        input: inputPath,
        ops: [{ type: 'grayscale' }],
        output: outputPath,
      })

      await editImage(specPath)

      const info = await imageInfo(outputPath)
      expect(info.format).toBe('png')
    })

    it('composite でオーバーレイを合成する', async () => {
      const dir = testDir('composite')
      const inputPath = path.join(dir, 'input.png')
      const overlayPath = path.join(dir, 'overlay.png')
      const outputPath = path.join(dir, 'out.png')
      await writeFixturePng(inputPath)
      await writeFixturePng(overlayPath, 50, 50)
      const specPath = writeSpec(dir, {
        input: inputPath,
        ops: [{ gravity: 'southeast', input: overlayPath, type: 'composite' }],
        output: outputPath,
      })

      await editImage(specPath)

      expect(await imageInfo(outputPath)).toMatchObject({ height: 300, width: 400 })
    })

    it('未知の op type は SpecError で失敗する', async () => {
      const dir = testDir('unknown-op')
      const inputPath = path.join(dir, 'input.png')
      await writeFixturePng(inputPath)
      const specPath = writeSpec(dir, {
        input: inputPath,
        ops: [{ type: 'sepia' }],
        output: path.join(dir, 'out.png'),
      })

      await expect(editImage(specPath)).rejects.toThrow(/unknown op type: "sepia"/)
    })

    it('存在しない spec ファイルは SpecError で失敗する', async () => {
      const dir = testDir('missing-spec')
      await expect(editImage(path.join(dir, 'missing.json'))).rejects.toThrow(/spec file not found/)
    })

    it('必須フィールドの欠落は SpecError で失敗する', async () => {
      const dir = testDir('missing-required-field')
      const inputPath = path.join(dir, 'input.png')
      await writeFixturePng(inputPath)
      const cases = [
        {
          message: /op "format" requires string field "format"/,
          op: { quality: 70, type: 'format' },
        },
        { message: /op "composite" requires string field "input"/, op: { type: 'composite' } },
        {
          message: /op "crop" requires number field "height"/,
          op: { left: 0, top: 0, type: 'crop', width: 10 },
        },
        { message: /op "rotate" requires number field "angle"/, op: { type: 'rotate' } },
        { message: /op "tint" requires string field "color"/, op: { type: 'tint' } },
      ]
      const specs = cases.map(({ message, op }, index) => {
        const specPath = path.join(dir, `spec-${index}.json`)
        writeFileSync(
          specPath,
          JSON.stringify({ input: inputPath, ops: [op], output: path.join(dir, 'out.png') })
        )
        return { message, specPath }
      })
      await Promise.all(
        specs.map(async ({ message, specPath }) =>
          expect(editImage(specPath)).rejects.toThrow(message)
        )
      )
    })
  })

  describe('imageInfo', () => {
    it('画像のメタデータとファイルサイズを返す', async () => {
      const dir = testDir('info')
      const inputPath = path.join(dir, 'input.png')
      await writeFixturePng(inputPath)

      const info = await imageInfo(inputPath)

      expect(info).toMatchObject({ format: 'png', hasAlpha: false, height: 300, width: 400 })
      expect(info.sizeBytes).toBeGreaterThan(0)
    })
  })
}
