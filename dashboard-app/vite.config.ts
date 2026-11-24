// Builds the one self-contained kit/dashboard/index.html (decision 0018).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    outDir: process.env.DASHBOARD_OUT ?? 'dist',
    emptyOutDir: true,
    // the original CSS ships byte for byte; a CSS minifier would rewrite colours and shorthands
    cssMinify: false,
    target: 'es2022',
  },
});
