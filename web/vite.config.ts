import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The Express API runs on :8787; the web app proxies /api to it.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
})
