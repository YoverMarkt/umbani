import { HashRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { session } from './api/client'
import Layout from './components/Layout'
import Login from './features/auth/Login'
import Repartidores from './features/repartidores/Repartidores'
import Carreras from './features/carreras/Carreras'
import Problemas from './features/problemas/Problemas'
import ComoFunciona from './features/guia/ComoFunciona'

// ═══════════════════════════════════════════════════════════════════════════
// EL PANEL DE UNA COOPERATIVA DE REPARTO (`/cooperativa`, 2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Como los «socios de flota» de las grandes: registra a sus motorizados, ve
// sus carreras semana a semana (y las descarga para calcular su comisión) y
// sus problemas. Cuatro pantallas, sin carga diferida: es pequeño.

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } },
})

function RequireAuth() {
  return session.token ? <Outlet /> : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth />}>
            <Route element={<Layout />}>
              <Route path="/" element={<Repartidores />} />
              <Route path="/carreras" element={<Carreras />} />
              <Route path="/problemas" element={<Problemas />} />
              <Route path="/como-funciona" element={<ComoFunciona />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  )
}
