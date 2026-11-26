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
    rolldownOptions: {
      output: {
        // Large, rarely-changing libraries get their own long-cacheable chunks.
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules[\\/]three[\\/]/, priority: 3 },
            {
              name: 'editor',
              test: /node_modules[\\/](@codemirror|@lezer|crelt|style-mod|w3c-keyname)[\\/]/,
              priority: 2,
            },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
