import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { initSealosDesktopSdk } from './sealosSdk'

if (typeof window !== 'undefined') {
  initSealosDesktopSdk()
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
