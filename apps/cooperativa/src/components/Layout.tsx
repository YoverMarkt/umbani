import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Bike, BookOpen, LogOut, Menu, ReceiptText, TriangleAlert } from 'lucide-react'
import { Button } from '@botpanel/ui/components/button'
import { Toaster } from '@botpanel/ui/components/sonner'
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@botpanel/ui/components/sheet'
import { session } from '../api/client'

const SECCIONES = [
  { to: '/', label: 'Repartidores', icon: Bike },
  { to: '/carreras', label: 'Carreras', icon: ReceiptText },
  { to: '/problemas', label: 'Problemas', icon: TriangleAlert },
  { to: '/como-funciona', label: 'Cómo funciona', icon: BookOpen },
]

export default function Layout() {
  const navigate = useNavigate()
  const [menuAbierto, setMenuAbierto] = useState(false)
  const salir = () => { session.clear(); navigate('/login') }

  const navegacion = (
    <>
      <div className="px-5 py-4 border-b border-border">
        <div className="font-bold text-foreground flex items-center gap-2"><Bike className="w-4 h-4 text-primary" /> Umbani</div>
        <div className="truncate text-xs text-muted-foreground">{session.nombre || 'Tu cooperativa'}</div>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto p-3 space-y-1">
        {SECCIONES.map(s => (
          <NavLink key={s.to} to={s.to} end={s.to === '/'} onClick={() => setMenuAbierto(false)}
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
        <Button variant="ghost" onClick={salir} className="w-full justify-start">
          <span className="inline-flex items-center gap-2"><LogOut className="w-4 h-4" /> Cerrar sesión</span>
        </Button>
      </div>
    </>
  )

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background md:flex-row">
      <aside className="hidden h-full w-60 shrink-0 bg-card border-r md:flex md:flex-col">
        {navegacion}
      </aside>
      <header className="flex h-14 items-center gap-3 border-b bg-card px-4 md:hidden">
        <Sheet open={menuAbierto} onOpenChange={setMenuAbierto}>
          <SheetTrigger asChild><Button variant="ghost" size="icon" aria-label="Abrir navegación"><Menu /></Button></SheetTrigger>
          <SheetContent side="left" className="w-72 gap-0 p-0" showCloseButton={false}>
            <SheetTitle className="sr-only">Navegación de la cooperativa</SheetTitle>
            <SheetDescription className="sr-only">Secciones del panel</SheetDescription>
            {navegacion}
          </SheetContent>
        </Sheet>
        <span className="truncate font-semibold">{session.nombre || 'Tu cooperativa'}</span>
      </header>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-4 md:p-6">
        <Outlet />
      </main>
      <Toaster position="bottom-right" expand />
    </div>
  )
}
