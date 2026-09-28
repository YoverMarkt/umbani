import { HashRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { session } from './api/client'
import { queryClient } from './lib/queryClient'
import Login from './features/auth/Login'
import Layout from './components/Layout'
import { Skeleton } from '@botpanel/ui/components/skeleton'

const Dashboard = lazy(() => import('./features/dashboard/Dashboard'))
const Catalog = lazy(() => import('./features/catalog/Catalog'))
const Sales = lazy(() => import('./features/sales/Sales'))
const Orders = lazy(() => import('./features/orders/Orders'))
const Reports = lazy(() => import('./features/reports/Reports'))
const MisPagos = lazy(() => import('./features/pagos/MisPagos'))
const Customers = lazy(() => import('./features/customers/Customers'))
const Reactivar = lazy(() => import('./features/customers/Reactivar'))
const Schedule = lazy(() => import('./features/schedule/Schedule'))
const Settings = lazy(() => import('./features/settings/Settings'))
const Users = lazy(() => import('./features/settings/Users'))

// Solo entra quien tiene sesión; si no, al login.
function RequireAuth() {
  return session.token ? <Outlet /> : <Navigate to="/login" replace />
}

const PageLoader = () => (
  <div>
    <Skeleton className="h-8 w-56 mb-6" />
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
      {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
    </div>
    <div className="grid lg:grid-cols-2 gap-4">
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  </div>
)

// HashRouter: funciona servido desde Express en /app sin config extra de rutas.
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth />}>
            <Route element={<Layout />}>
              <Route element={<Suspense fallback={<PageLoader />}><Outlet /></Suspense>}>
              <Route path="/" element={<Dashboard />} />
              {/* ⚠️ `Conversaciones` se retiró el 2026-08-23. El enlace
                  guardado cae en el comodín de más abajo, que lleva a Inicio. */}
              <Route path="/catalog" element={<Catalog />} />
              <Route path="/sales" element={<Sales />} />
              <Route path="/orders" element={<Orders />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/pagos" element={<MisPagos />} />
              <Route path="/customers" element={<Customers />} />
              <Route path="/reactivate" element={<Reactivar />} />
              {/* ⚠️ «Bienvenida» se retiró el 2026-09-20: el saludo y las
                  políticas que el dueño escribía aquí no los leía NADIE — se
                  guardaban en `bot_policies` y ningún servicio del bot, del
                  marketplace ni de la tienda los consultaba. Ahora cada local
                  se presenta desde Umbani. Los enlaces viejos van al inicio,
                  no a una pantalla que ya no existe. */}
              <Route path="/bienvenida" element={<Navigate to="/" replace />} />
              <Route path="/policies" element={<Navigate to="/" replace />} />
              <Route path="/bot-prompt" element={<Navigate to="/" replace />} />
              <Route path="/users" element={<Users />} />
              <Route path="/schedule" element={<Schedule />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Route>
          </Route>
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  )
}
