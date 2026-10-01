import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, session } from '../api/client'
import { queryClient } from '../lib/queryClient'
import { useBusinessInfo, isOrderBiz } from '../lib/biz'
import { Home, Package, BarChart3, Users, RotateCcw, Clock, UserRound, Settings, LogOut, Sun, Moon, Menu, Receipt, Wallet, FlaskConical } from 'lucide-react'
import { useState } from 'react'
import { getTheme, toggleTheme } from '../lib/theme'
import { AlarmBanner } from './AlarmSystem'
import { useAttention } from '../hooks/useAttention'
import { Button } from '@botpanel/ui/components/button'
import { Toaster } from '@botpanel/ui/components/sonner'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@botpanel/ui/components/sheet'

// Secciones del panel (mismas reglas del panel viejo):
// · `perm` controla visibilidad para empleados (el dueño ve todo; el SERVIDOR valida siempre)
// · Horarios para TODOS (horario de atención; el bot avisa fuera de horario)
// · Catálogo se llama siempre así: desde el 2026-08-20 no hay negocios de servicios

export default function Layout() {
  const navigate = useNavigate()
  const [theme, setTheme] = useState(getTheme())
  const [menuOpen, setMenuOpen] = useState(false)
  const user = session.user
  const biz = session.business
  const { data: bizInfo } = useBusinessInfo()

  // Sin fallback local a propósito: takes_orders no viaja en el login, y el
  // dato vivo del servidor manda si el superadmin activa pedidos hoy mismo.
  const orderBiz = isOrderBiz(bizInfo?.takes_orders)
  const canSee = (perm: string | null) => {
    if (!perm) return true
    if (user?.role === 'owner') return true
    if (perm === 'owner') return false
    return (user?.permissions ?? []).includes(perm)
  }

  // Contador de productos junto a "Catálogo" (sb-cnt del panel viejo)
  const { data: quick } = useQuery({
    queryKey: ['quick-stats'],
    queryFn: () => api<{ totalProducts: number }>('/api/client/stats'),
    staleTime: 60_000,
  })

  const att = useAttention({
    watchOrders: orderBiz && canSee('ventas'),
  })

  // Menú IDÉNTICO al panel viejo (mismo orden, mismas secciones)
  const SECTIONS: { to: string; label: string; icon: React.ComponentType<{ className?: string }>; perm: string | null; badge?: string | number; badgeTone?: 'alert' | 'count' }[] = [
    { to: '/',              label: 'Inicio',            icon: Home, perm: null },
    { to: '/catalog',       label: 'Catálogo', icon: Package, perm: 'catalogo', badge: quick?.totalProducts || undefined, badgeTone: 'count' as const },
    // ⚠️ Aquí estaba «Conversaciones», retirada el 2026-08-23. El dueño de un
    // local del marketplace no tiene chats que leer: sus clientes escriben al
    // número de Umbani y `marketplace-entry.ts` no escribe una sola fila en
    // `conversation_history` — la última de producción es de las 04:41 de ese
    // día. La pantalla enseñaba un archivo muerto y prometía dos botones que
    // no hacían nada (modo manual y responder a mano).
    ...(orderBiz ? [{ to: '/orders', label: 'Pedidos', icon: Receipt, perm: 'ventas', badge: att.pendingOrders.length || undefined }] : []),
    { to: '/reports',       label: 'Reportes',          icon: BarChart3, perm: 'reportes' },
    // Solo el dueño y solo si vende: son los depósitos a SU cuenta.
    ...(orderBiz ? [{ to: '/pagos', label: 'Mis pagos', icon: Wallet, perm: 'owner' }] : []),
    { to: '/customers',     label: 'Clientes',          icon: Users, perm: 'reportes' },
    { to: '/reactivate',    label: 'Reactivar',         icon: RotateCcw, perm: 'reportes' },
    { to: '/schedule',      label: 'Horarios',          icon: Clock, perm: 'horarios' },
    { to: '/users',         label: 'Usuarios',          icon: UserRound, perm: 'owner' },
    { to: '/settings',      label: 'Ajustes',           icon: Settings, perm: 'owner' },
  ]

  function logout() {
    session.clear()
    // El caché no puede sobrevivir a la sesión: otro negocio heredaría sus datos
    queryClient.clear()
    navigate('/login')
  }

  const navigation = (
    <>
      <div className="px-5 py-4 border-b border-border/60">
        <div className="font-bold text-foreground truncate">{biz?.name ?? 'Mi negocio'}</div>
        <div className="text-xs text-muted-foreground">{biz?.type ?? ''}</div>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto p-3 space-y-1">
        {SECTIONS.filter(s => canSee(s.perm)).map(s => (
          <NavLink
            key={s.to} to={s.to} end={s.to === '/'} onClick={() => setMenuOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/50'
              }`
            }
          >
            <s.icon className="w-4 h-4" />
            <span className="flex-1">{s.label}</span>
            {s.badge !== undefined && (
              <span className={`text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-5 text-center ${
                s.badgeTone === 'count' ? 'bg-muted text-muted-foreground' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
              }`}>
                {s.badge}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="p-3 border-t border-border/60">
        <Button variant="ghost" onClick={() => setTheme(toggleTheme())} className="w-full justify-start">
          <span className="inline-flex items-center gap-2">
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            {theme === 'dark' ? 'Tema claro' : 'Tema oscuro'}
          </span>
        </Button>
        <div className="px-3 pb-2 text-xs text-muted-foreground truncate">{user?.name || 'Sesión activa'}</div>
        <Button variant="ghost" onClick={logout} className="w-full justify-start">
          <span className="inline-flex items-center gap-2"><LogOut className="w-4 h-4" /> Cerrar sesión</span>
        </Button>
      </div>
    </>
  )

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-muted md:flex-row">
      <aside className="hidden h-full w-60 shrink-0 bg-card border-r md:flex md:flex-col">
        {navigation}
      </aside>

      <header className="flex h-14 items-center gap-3 border-b bg-card px-4 md:hidden">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild><Button variant="ghost" size="icon" aria-label="Abrir navegación"><Menu /></Button></SheetTrigger>
          <SheetContent side="left" className="w-72 gap-0 p-0" showCloseButton={false}>
            <SheetTitle className="sr-only">Navegación del negocio</SheetTitle>
            <SheetDescription className="sr-only">Secciones del panel</SheetDescription>
            {navigation}
          </SheetContent>
        </Sheet>
        <span className="truncate font-semibold">{biz?.name ?? 'Mi negocio'}</span>
      </header>

      {/* Contenido */}
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
        {/* Local de DEMOSTRACIÓN (2026-09-30): nadie puede confundir sus montos
            con dinero de verdad, ni quien enseña la demo ni quien la mira. */}
        {biz?.demo && (
          <div role="note" className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span><strong>Local de demostración.</strong> Sus pedidos y montos son de prueba: Umbani no los cobra ni los paga.</span>
          </div>
        )}
        <Outlet />
      </main>

      {/* Alarma global: pedidos por aceptar y comprobantes por revisar */}
      <AlarmBanner
        ordersPending={att.pendingOrders}
        ordersLoaded={att.ordersLoaded}
      />

      {/* Notificaciones de la librería (Sonner) — expand: apiladas sin taparse */}
      <Toaster position="bottom-right" expand />
    </div>
  )
}
