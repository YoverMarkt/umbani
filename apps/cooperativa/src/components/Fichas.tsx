import type { ReactNode } from 'react'

// ═══════════════════════════════════════════════════════════════════════════
// EN EL TELÉFONO, CADA FILA ES UNA TARJETA (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// La cooperativa abre esto en el teléfono durante el turno, y las tablas se
// cortaban por la derecha justo en lo que más importa: el saldo, el estado,
// el botón. En pantallas anchas sigue la tabla (`SoloEnPantallaAncha`); en el
// teléfono, estas tarjetas con todo a la vista.

export function SoloEnPantallaAncha({ children }: { children: ReactNode }) {
  return <div className="hidden md:block">{children}</div>
}

export function Fichas({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border md:hidden">{children}</div>
}

export function Ficha({ titulo, detalle, derecha, children }: {
  titulo: ReactNode
  detalle?: ReactNode
  derecha?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="space-y-2 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-foreground">{titulo}</div>
          {detalle && <div className="text-xs text-muted-foreground">{detalle}</div>}
        </div>
        {derecha && <div className="shrink-0">{derecha}</div>}
      </div>
      {children}
    </div>
  )
}

export function Dato({ nombre, valor }: { nombre: string; valor: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{nombre}</span>
      <span className="text-right tabular-nums text-foreground">{valor}</span>
    </div>
  )
}
