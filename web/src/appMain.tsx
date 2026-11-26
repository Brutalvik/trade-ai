import { StrictMode, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { PrivyProvider } from '@privy-io/react-auth'
import { Analytics } from '@vercel/analytics/react'
import App from './App.tsx'
import { PrivyEnabled } from './Account.tsx'

// The trading app (at /app). Sign-up and sign-in run on MoonPay (every account gets its own MoonPay
// wallet) when the server has MoonPay's wallet keys; otherwise on Privy when it has a Privy app ID.
// While both are set, Privy stays loaded so customers' previous (Privy) wallets still work.
// Both values come from /api/status and are public; they're cached so the page shows instantly next time.
const CACHE = 'nexus-privy-app-id'
const MOONX_CACHE = 'nexus-moonx-key'
type MoonPayKit = typeof import('./MoonPaySignIn.tsx')

export function start(root: Root) {
  let kit: MoonPayKit | null = null
  const render = (appId: string | null, moonxKey: string | null) => {
    const withMoonPay = (app: ReactNode) => (moonxKey && kit ? <kit.MoonPayRoot publishableKey={moonxKey}>{app}</kit.MoonPayRoot> : app)
    root.render(
      <StrictMode>
        {appId ? (
          <PrivyProvider
            appId={appId}
            config={{
              loginMethods: ['email', 'google'],
              appearance: { theme: 'dark', accentColor: '#00e5ff', landingHeader: 'Sign in to TRADING//RUST', loginMessage: 'Your own paper account and Solana wallet' },
              embeddedWallets: { solana: { createOnLogin: 'users-without-wallets' } },
            }}
          >
            <PrivyEnabled.Provider value={true}>{withMoonPay(<App />)}</PrivyEnabled.Provider>
          </PrivyProvider>
        ) : (
          withMoonPay(<App />)
        )}
        <Analytics />
      </StrictMode>,
    )
  }
  // MoonPay's kit is large: it's only downloaded when MoonPay sign-in is switched on.
  const loadKit = async (moonxKey: string | null) => {
    if (moonxKey && !kit) kit = await import('./MoonPaySignIn.tsx').catch(() => null)
  }
  const cached = localStorage.getItem(CACHE)
  const cachedMoonx = localStorage.getItem(MOONX_CACHE)
  // With MoonPay on last time, wait for its kit before the first paint, so sign-in doesn't switch under the visitor.
  void loadKit(cachedMoonx).then(() => {
    render(cached, cachedMoonx)
    return fetch('/api/status')
      .then((r) => r.json())
      .then(async (s: { privyAppId?: string | null; moonpayWallets?: { on?: boolean; publishableKey?: string | null } }) => {
        const id = s.privyAppId ?? null
        const moonx = s.moonpayWallets?.on && s.moonpayWallets.publishableKey ? s.moonpayWallets.publishableKey : null
        if (id === cached && moonx === cachedMoonx) return
        if (id) localStorage.setItem(CACHE, id)
        else localStorage.removeItem(CACHE)
        if (moonx) localStorage.setItem(MOONX_CACHE, moonx)
        else localStorage.removeItem(MOONX_CACHE)
        await loadKit(moonx)
        render(id, moonx)
      })
      .catch(() => {})
  })
}
