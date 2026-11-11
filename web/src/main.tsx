import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PrivyProvider } from '@privy-io/react-auth'
import './index.css'
import App from './App.tsx'
import { PrivyEnabled } from './Account.tsx'

// Sign-in and wallets run on Privy when the server has a Privy app ID (from /api/status).
// The ID is public; it's cached so the page shows instantly next time.
const CACHE = 'nexus-privy-app-id'
const root = createRoot(document.getElementById('root')!)

function render(appId: string | null) {
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
          <PrivyEnabled.Provider value={true}>
            <App />
          </PrivyEnabled.Provider>
        </PrivyProvider>
      ) : (
        <App />
      )}
    </StrictMode>,
  )
}

const cached = localStorage.getItem(CACHE)
render(cached)
fetch('/api/status')
  .then((r) => r.json())
  .then((s: { privyAppId?: string | null }) => {
    const id = s.privyAppId ?? null
    if (id === cached) return
    if (id) localStorage.setItem(CACHE, id)
    else localStorage.removeItem(CACHE)
    render(id)
  })
  .catch(() => {})
