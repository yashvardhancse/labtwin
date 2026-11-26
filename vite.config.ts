import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// `base: './'` makes every asset URL relative, so the same build works at
// https://<user>.github.io/<repo>/, on Vercel/Cloudflare Pages, or behind nginx.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
