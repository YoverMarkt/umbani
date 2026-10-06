import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// El panel de una cooperativa de reparto (2026-10-06): claro siempre, como lo
// abren en el teléfono durante el turno.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
