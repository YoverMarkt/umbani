import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import RepartidorApp from './RepartidorApp'

// La app web de repartidores (`/r`): otra página de la mini app, como `/u`.
// Comparte el diseño y el login de pruebas, con su PROPIA sesión (ver
// `repartidor/api.ts`); quien abre una tienda no descarga nada de esto.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RepartidorApp />
  </StrictMode>,
)
