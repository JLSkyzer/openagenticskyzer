import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' is required because main.cjs loads the built index.html via file://
// (loadFile) in production — absolute "/assets/..." paths do not resolve under file://.
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react()],
  build: {
    outDir: '../renderer-dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
