import { defineConfig } from 'vite'

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
})
