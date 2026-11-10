import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

// Version shown in the footer: package.json version + the git commit being built
// (Vercel provides VERCEL_GIT_COMMIT_SHA; locally we ask git).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
let commit = process.env.VERCEL_GIT_COMMIT_SHA ?? ''
if (!commit) {
  try {
    commit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    commit = ''
  }
}

// The Express API runs on :8787; the web app proxies /api to it.
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit.slice(0, 7)),
  },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
})
