import { copyFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'

const require = createRequire(import.meta.url)

const copyNodeModuleFile = (from: string, to: string): void => {
  copyFileSync(require.resolve(from), path.resolve('scripts', to))
}

const copyRenderAssets = (): Plugin => ({
  closeBundle(): void {
    copyNodeModuleFile('@resvg/resvg-wasm/index_bg.wasm', 'resvg.wasm')
    copyNodeModuleFile(
      '@expo-google-fonts/noto-sans-jp/400Regular/NotoSansJP_400Regular.ttf',
      'NotoSansJP_400Regular.ttf'
    )
    copyNodeModuleFile('@expo-google-fonts/noto-sans-jp/LICENSE_FONT', 'NotoSansJP_LICENSE_OFL.txt')
  },
  name: 'copy-render-assets',
})

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'scripts/vl2svg.ts',
      fileName: () => 'vl2svg.mjs',
      formats: ['es'] as const,
    },
    minify: false,
    outDir: 'scripts',
    rollupOptions: {
      external: [/^node:/],
    },
    target: 'node18',
  },
  define: {
    'import.meta.vitest': 'undefined',
  },
  plugins: [copyRenderAssets()],
})
