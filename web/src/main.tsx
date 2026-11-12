import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// The landing page lives at "/", the trading app at "/app". Each loads only its own code:
// the landing page never downloads the app (or Privy). Old links to the app's pages
// (/#guide, /#privacy, /#terms) still open them in the app.
const path = window.location.pathname
const inApp = path === '/app' || path.startsWith('/app/')
const root = createRoot(document.getElementById('root')!)

if (inApp) {
  void import('./appMain.tsx').then((m) => m.start(root))
} else if (/^#(guide|rules|privacy|terms)$/.test(window.location.hash)) {
  window.location.replace('/app' + window.location.hash)
} else {
  const Landing = lazy(() => import('./Landing.tsx'))
  root.render(
    <StrictMode>
      <Suspense fallback={null}>
        <Landing />
      </Suspense>
    </StrictMode>,
  )
}
