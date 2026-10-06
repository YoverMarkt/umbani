import { HashRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense } from 'react'
import { session } from './api/client'
import Login from './features/auth/Login'
import Layout from './components/Layout'
import { Skeleton } from '@botpanel/ui/components/skeleton'

const Dashboard = lazy(() => import('./features/dashboard/Dashboard'))
const Umbani = lazy(() => import('./features/umbani/Umbani'))
const Clients = lazy(() => import('./features/clients/Clients'))
const Billing = lazy(() => import('./features/billing/Billing'))
const Simulator = lazy(() => import('./features/simulator/Simulator'))
const ServerSettings = lazy(() => import('./features/settings/ServerSettings'))
const Connections = lazy(() => import('./features/settings/Connections'))
const Calculator = lazy(() => import('./features/calculator/Calculator'))
const Usage = lazy(() => import('./features/usage/Usage'))
const Errors = lazy(() => import('./features/errors/Errors'))
const Finance = lazy(() => import('./features/pricing/Finance'))
const Pagos = lazy(() => import('./features/pagos/Pagos'))
const Motorizados = lazy(() => import('./features/motorizados/Motorizados'))
const Ciudades = lazy(() => import('./features/ciudades/Ciudades'))
const Cooperativas = lazy(() => import('./features/cooperativas/Cooperativas'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
})

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
              <Route path="/clients" element={<Clients />} />
              <Route path="/billing" element={<Billing />} />
              <Route path="/finance" element={<Finance />} />
              <Route path="/pagos" element={<Pagos />} />
              <Route path="/motorizados" element={<Motorizados />} />
              <Route path="/ciudades" element={<Ciudades />} />
              <Route path="/cooperativas" element={<Cooperativas />} />
              <Route path="/usage" element={<Usage />} />
              <Route path="/umbani" element={<Umbani />} />
              <Route path="/simulator" element={<Simulator />} />
              <Route path="/settings" element={<ServerSettings />} />
              <Route path="/connections" element={<Connections />} />
              <Route path="/errors" element={<Errors />} />
              <Route path="/calculator" element={<Calculator />} />
              <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Route>
          </Route>
        </Routes>
      </HashRouter>
    </QueryClientProvider>
  )
}
