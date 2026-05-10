import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: false
  },
  server: {
    port: 5179,
    strictPort: true
  }
});
