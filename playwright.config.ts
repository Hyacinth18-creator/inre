import { defineConfig, devices } from '@playwright/test'
import chromiumBinary from '@sparticuz/chromium'

const executablePath = await chromiumBinary.executablePath()
const chromiumArgs = chromiumBinary.args.filter((argument) => argument !== '--single-process')
const testDatabasePath = `/tmp/shwari-playwright-${process.pid}.sqlite`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
    launchOptions: { executablePath, args: chromiumArgs },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'concurrently -k -n API,WEB "npm run dev:api" "vite --host 127.0.0.1 --port 4174 --strictPort"',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: '8877',
      SHWARI_DB_PATH: testDatabasePath,
      VITE_API_PROXY_TARGET: 'http://127.0.0.1:8877',
    },
  },
})