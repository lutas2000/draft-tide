import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The trusted GUI only. Design previews never load here (they get the
// isolated Preview Host, M1-06).
export default defineConfig({
  root: fileURLToPath(new URL('./src/gui', import.meta.url)),
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('./dist/gui', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: { port: 5317, strictPort: true, host: '127.0.0.1' },
});
