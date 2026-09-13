import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: 'web', resolve: { alias: {
  '/leaflet.js': fileURLToPath(new URL('./node_modules/leaflet/dist/leaflet-src.esm.js', import.meta.url)),
  '/leaflet.css': fileURLToPath(new URL('./node_modules/leaflet/dist/leaflet.css', import.meta.url)),
} }, build: { outDir: '../dist/client', emptyOutDir: true, rollupOptions: { input: {
  app: fileURLToPath(new URL('./web/index.html', import.meta.url)),
  naverReviews: fileURLToPath(new URL('./web/naver-reviews.html', import.meta.url))
} } } });
