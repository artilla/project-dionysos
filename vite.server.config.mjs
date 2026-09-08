import { defineConfig } from 'vite';
import { sites } from '@openai/sites-vite-plugin';
export default defineConfig({
  plugins: [sites()],
  build: { ssr: 'server/worker.mjs', outDir: 'dist/server', emptyOutDir: true, rolldownOptions: { output: { entryFileNames: 'index.js' } } },
  ssr: { target: 'webworker', noExternal: true },
  resolve: { conditions: ['workerd', 'worker', 'browser'] }
});
