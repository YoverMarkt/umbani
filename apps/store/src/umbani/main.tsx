import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import UmbaniApp from './UmbaniApp'

// La app web de clientes (`/u`): una segunda página de la mini app, con su
// propio arranque. Comparte el diseño y la sesión de dispositivo de la tienda,
// pero no su carga: quien abre una tienda desde WhatsApp no descarga esto.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UmbaniApp />
  </StrictMode>,
)
