import { defineConfig } from 'vite'
import monaco from 'vite-plugin-monaco-editor'

const monacoPluginFactory: any = (monaco as any)?.default ?? (monaco as any)

export default defineConfig({
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  plugins: [monacoPluginFactory({
    languageWorkers: ['editorWorkerService', 'css', 'html', 'json', 'typescript'],
  })],
})

