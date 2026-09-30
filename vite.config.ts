import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Relative base so the built dist/ also works when loaded from file://
  // inside packaging shells (Electron / Tauri / Capacitor).
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    // Keep theme assets as real files instead of inlining them, so
    // public/themes/** can be swapped without rebuilding the bundle.
    assetsInlineLimit: 0
  },
  test: {
    // Core logic is DOM-free by design, so the node environment is enough.
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})
