import { StrictMode, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Analytics } from '@vercel/analytics/react'
import App from './App.tsx'

// The trading app (at /app). Sign-up and sign-in run on MoonPay (every account gets its own MoonPay
// wallet) when the server has MoonPay's wallet keys; without them, the app's own username and
// password sign-in. Whether MoonPay is on comes from /api/status (public, cached so the page shows
// instantly next time).
const MOONX_CACHE = 'nexus-moonx-key'
type MoonPayKit = typeof import('./MoonPaySignIn.tsx')

export function start(root: Root) {
  localStorage.removeItem('nexus-privy-app-id') // (left by the old Privy sign-in)
  let kit: MoonPayKit | null = null
  const render = (moonxKey: string | null) => {
    const app: ReactNode = <App />
    root.render(
      <StrictMode>
        {moonxKey && kit ? <kit.MoonPayRoot publishableKey={moonxKey}>{app}</kit.MoonPayRoot> : app}
        <Analytics />
      </StrictMode>,
    )
  }
  // MoonPay's kit is large: it's only downloaded when MoonPay sign-in is switched on.
  const loadKit = async (moonxKey: string | null) => {
    if (moonxKey && !kit) kit = await import('./MoonPaySignIn.tsx').catch(() => null)
  }
  const cached = localStorage.getItem(MOONX_CACHE)
  // With MoonPay on last time, wait for its kit before the first paint, so sign-in doesn't switch under the visitor.
  void loadKit(cached).then(() => {
    render(cached)
    return fetch('/api/status')
      .then((r) => r.json())
      .then(async (s: { moonpayWallets?: { on?: boolean; publishableKey?: string | null } }) => {
        const moonx = s.moonpayWallets?.on && s.moonpayWallets.publishableKey ? s.moonpayWallets.publishableKey : null
        if (moonx === cached) return
        if (moonx) localStorage.setItem(MOONX_CACHE, moonx)
        else localStorage.removeItem(MOONX_CACHE)
        await loadKit(moonx)
        render(moonx)
      })
      .catch(() => {})
  })
}
