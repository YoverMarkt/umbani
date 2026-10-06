import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { session } from '../api/client'
import { Compass, LayoutDashboard, Users, CreditCard, Landmark, MessageSquare, Plug, Settings, Calculator, LogOut, Crown, Sun, Moon, Menu, Shield, FileText, Gauge, TriangleAlert, Wallet, Bike, MapPin, Handshake } from 'lucide-react'
import { useState } from 'react'
import { getTheme, toggleTheme } from '../lib/theme'
import { Button } from '@botpanel/ui/components/button'
import { Toaster } from '@botpanel/ui/components/sonner'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@botpanel/ui/components/sheet'

const SECTIONS = [
  { to: '/',            label: 'Dashboard',     icon: LayoutDashboard },
  { to: '/clients',     label: 'Clientes',      icon: Users },
  { to: '/usage',       label: 'Medición',      icon: Gauge },
  { to: '/umbani',      label: 'Uso de Umbani', icon: Compass },
  { to: '/billing',     label: 'Facturación',   icon: CreditCard },
  { to: '/finance',     label: 'Finanzas',      icon: Landmark },
  { to: '/pagos',       label: 'Pagos',         icon: Wallet },
  { to: '/motorizados', label: 'Motorizados',   icon: Bike },
  { to: '/ciudades',    label: 'Ciudades',      icon: MapPin },
  { to: '/cooperativas', label: 'Cooperativas', icon: Handshake },
  { to: '/simulator',   label: 'Simulador',     icon: MessageSquare },
  { to: '/connections', label: 'Conexiones',    icon: Plug },
  { to: '/errors',      label: 'Errores',       icon: TriangleAlert },
  { to: '/settings',    label: 'Configuración', icon: Settings },
  { to: '/calculator',  label: 'Calculadora',   icon: Calculator },
]

export default function Layout() {
  const navigate = useNavigate()
  const [theme, setTheme] = useState(getTheme())
  const [menuOpen, setMenuOpen] = useState(false)

  function logout() {
    session.clear()
    navigate('/login')
  }

  const navigation = (
    <>
      <div className="px-5 py-4 border-b border-border">
        <div className="font-bold text-foreground flex items-center gap-2"><Crown className="w-4 h-4 text-primary" /> BotPanel</div>
        <div className="text-xs text-muted-foreground">Superadmin</div>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto p-3 space-y-1">
        {SECTIONS.map(s => (
          <NavLink key={s.to} to={s.to} end={s.to === '/'} onClick={() => setMenuOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted'
              }`
            }>
            <s.icon className="w-4 h-4" /> {s.label}
          </NavLink>
        ))}
      </nav>
      <div className="p-3 border-t border-border">
        {/* Páginas legales públicas de Vezzper (se sirven fuera de la app React) */}
        <div className="mb-1 flex flex-col gap-0.5">
          <a href="/privacidad" target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted">
            <Shield className="w-4 h-4" /> Política de Privacidad
          </a>
          <a href="/terminos" target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted">
            <FileText className="w-4 h-4" /> Términos y Condiciones
          </a>
        </div>
        <Button variant="ghost" onClick={() => setTheme(toggleTheme())} className="w-full justify-start">
          <span className="inline-flex items-center gap-2">
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            {theme === 'dark' ? 'Tema claro' : 'Tema oscuro'}
          </span>
        </Button>
        <Button variant="ghost" onClick={logout} className="w-full justify-start">
          <span className="inline-flex items-center gap-2"><LogOut className="w-4 h-4" /> Cerrar sesión</span>
        </Button>
      </div>
    </>
  )

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background md:flex-row">
      <aside className="hidden h-full w-60 shrink-0 bg-card border-r md:flex md:flex-col">
        {navigation}
      </aside>
      <header className="flex h-14 items-center gap-3 border-b bg-card px-4 md:hidden">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild><Button variant="ghost" size="icon" aria-label="Abrir navegación"><Menu /></Button></SheetTrigger>
          <SheetContent side="left" className="w-72 gap-0 p-0" showCloseButton={false}>
            <SheetTitle className="sr-only">Navegación del superadmin</SheetTitle>
            <SheetDescription className="sr-only">Secciones de BotPanel</SheetDescription>
            {navigation}
          </SheetContent>
        </Sheet>
        <span className="font-semibold">BotPanel</span>
      </header>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-4 md:p-6">
        <Outlet />
      </main>

      {/* Notificaciones de la librería (Sonner) — expand: apiladas sin taparse */}
      <Toaster position="bottom-right" expand />
    </div>
  )
}
