import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['e2e/**', 'server/**', 'node_modules/**', 'dist/**', 'dist-server/**'],
  },
})