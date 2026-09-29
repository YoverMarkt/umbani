import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Badge } from '@botpanel/ui/components/badge'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { getRegistro } from './api'
import type { MovimientoDeDinero } from './api'

// ═══════════════════════════════════════════════════════════════════════════
// EL REGISTRO DE QUIÉN MUEVE DINERO (2026-09-29)
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo escribe la BASE, en la misma transacción que cada cambio, y no se puede
// editar ni borrar. Esta pantalla solo lo traduce a español.

const hora = (iso: string) => new Date(iso).toLocaleString('es-EC', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
})

const dinero = (centavos: unknown) => {
  const n = Number(centavos)
  if (!Number.isFinite(n)) return '—'
  return (n < 0 ? '-$' : '$') + (Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const dolares = (monto: unknown) => {
  const n = Number(monto)
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—'
}

/** Quién lo hizo, dicho para una persona. */
function Quien({ actor }: { actor: string }) {
  if (actor === 'sistema') return <span className="text-muted-foreground">Automático</span>
  // ⚠️ Un cambio que NO pasó por el servidor —el editor SQL de Supabase— es
  // justo el que más conviene ver, así que se señala.
  if (actor === 'base') return <Badge variant="destructive">Cambio directo en la base</Badge>
  const [tipo, ...resto] = actor.split(':')
  const quien = resto.join(':')
  const etiqueta = tipo === 'superadmin' ? 'Superadmin' : tipo === 'local' ? 'Local' : tipo === 'script' ? 'Script' : tipo
  return (
    <div className="leading-tight">
      <div className="text-xs text-muted-foreground">{etiqueta}</div>
      <div className="break-all">{quien || actor}</div>
    </div>
  )
}

const ESTADO: Record<string, string> = {
  por_pagar: 'por pagar', por_cobrar: 'por cobrar', en_cero: 'en cero', pagada: 'pagada',
  cobrada: 'cobrada', compensada: 'pasó a la semana siguiente',
  pending: 'pendiente', paid: 'pagada', overdue: 'vencida',
}
const TARJETA: Record<string, string> = {
  aprobado: 'Cobro con tarjeta aprobado', no_confirmado: 'PayPhone lo devolvió solo',
  por_devolver: 'Cobro con tarjeta por devolver', devuelto: 'Cobro con tarjeta devuelto',
  devolucion_manual: 'Cobro con tarjeta: devolver a mano',
}
const MODO: Record<string, string> = { pruebas: 'en pruebas', produccion: 'de verdad' }

/** Qué pasó, en una frase. */
function que(m: MovimientoDeDinero): string {
  const a = m.action
  if (a === 'liquidacion_cerrada') return 'Cierre semanal del local'
  if (a === 'liquidacion_motorizado_cerrada') return 'Cierre semanal del motorizado'
  if (a.startsWith('liquidacion_motorizado_')) return `Liquidación del motorizado ${ESTADO[a.slice(23)] ?? a.slice(23)}`
  if (a.startsWith('liquidacion_')) return `Liquidación del local ${ESTADO[a.slice(12)] ?? a.slice(12)}`
  if (a === 'carrera_retenida') return 'Carrera retenida al motorizado'
  if (a === 'carrera_liberada') return 'Carrera liberada al motorizado'
  if (a.startsWith('tarjeta_') && TARJETA[a.slice(8)]) return TARJETA[a.slice(8)]
  if (a === 'tarjeta_del_local') return 'Tarjeta del local'
  if (a === 'pago_confirmado') return 'Pago confirmado'
  if (a === 'pedido_pagado_cancelado') return 'Pedido YA PAGADO cancelado'
  if (a === 'factura_creada') return 'Factura creada'
  if (a.startsWith('factura_')) return `Factura ${ESTADO[a.slice(8)] ?? a.slice(8)}`
  if (a === 'margen_creado') return 'Regla de margen creada'
  if (a === 'margen_cambiado') return 'Regla de margen cambiada'
  if (a === 'margen_borrado') return 'Regla de margen borrada'
  if (a === 'ajuste_service_fee') return 'Tarifa de servicio'
  if (a === 'ajuste_payphone_fee_bps') return 'Comisión de PayPhone (estimada)'
  if (a === 'segundo_paso_configurado') return 'Segundo paso del superadmin configurado'
  if (a === 'segundo_paso_reiniciado') return 'Segundo paso del superadmin REINICIADO'
  return a
}

const texto = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v))
const objeto = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})

/** Lo que cambió, lo justo para entenderlo sin abrir la base. */
function detalle(m: MovimientoDeDinero): string {
  const d = m.detail || {}
  const antes = objeto(d.antes)
  const despues = objeto(d.despues)
  const a = m.action
  if (a.startsWith('liquidacion_')) {
    if (d.neto_cents !== undefined) return `Neto ${dinero(d.neto_cents)}`
    const ref = despues.referencia ? ` · ref. ${texto(despues.referencia)}` : ''
    return `Neto ${dinero(despues.neto_cents)}${ref}`
  }
  if (a.startsWith('carrera_')) return `${dinero(d.reparto_cents)}${d.motivo ? ` · ${texto(d.motivo)}` : ''}`
  if (a === 'tarjeta_del_local') {
    return `${MODO[String(d.antes)] ?? 'apagada'} → ${MODO[String(d.despues)] ?? 'apagada'}`
  }
  if (a.startsWith('tarjeta_')) {
    const modo = d.modo === 'pruebas' ? ' · prueba' : ''
    return `${dinero(d.cobrado_cents ?? d.monto_cents)}${d.payphone ? ` · PayPhone ${texto(d.payphone)}` : ''}${modo}`
  }
  if (a === 'pago_confirmado' || a === 'pedido_pagado_cancelado') {
    return `Pedido #${texto(d.numero)} · ${dolares(d.total)} · ${texto(d.metodo)}`
  }
  if (a === 'factura_creada') return dolares(d.monto)
  if (a.startsWith('factura_')) return `${dolares(antes.monto)} → ${dolares(despues.monto)}`
  if (a.startsWith('margen_')) {
    const regla = a === 'margen_cambiado' ? despues : d
    const cuanto = regla.porcentaje != null ? `${texto(regla.porcentaje)} %` : dolares(regla.fijo)
    return a === 'margen_cambiado'
      ? `${antes.porcentaje != null ? `${texto(antes.porcentaje)} %` : dolares(antes.fijo)} → ${cuanto}`
      : `${cuanto} · ${texto(regla.alcance)}`
  }
  if (a.startsWith('ajuste_')) return `${texto(d.antes)} → ${texto(d.despues)}`
  return ''
}

export default function Registro() {
  const [antes, setAntes] = useState<number | undefined>(undefined)
  const [anteriores, setAnteriores] = useState<MovimientoDeDinero[]>([])
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['adm-pagos-registro', antes],
    queryFn: () => getRegistro(antes),
  })

  if (isLoading && !anteriores.length) return <Skeleton className="h-48 w-full" />
  if (error) return <p className="text-sm text-destructive">No se pudo cargar el registro.</p>

  const filas = [...anteriores, ...(data?.movimientos ?? [])]
  const hayMas = (data?.movimientos.length ?? 0) === 200

  return (
    <Card className="p-0">
      <p className="px-4 pt-4 text-sm text-muted-foreground">
        Quién movió dinero, cuándo y qué cambió. Lo anota la base en el mismo momento del cambio: no se puede editar ni borrar.
      </p>
      {filas.length === 0
        ? <p className="p-6 text-sm text-muted-foreground">Todavía no hay movimientos.</p>
        : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Quién</TableHead>
                <TableHead>Local</TableHead>
                <TableHead>Qué pasó</TableHead>
                <TableHead>Detalle</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filas.map(m => (
                <TableRow key={m.id}>
                  <TableCell className="whitespace-nowrap">{hora(m.created_at)}</TableCell>
                  <TableCell className="max-w-56"><Quien actor={m.actor} /></TableCell>
                  <TableCell>{m.business_name || '—'}</TableCell>
                  <TableCell>{que(m)}</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{detalle(m)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      {hayMas && (
        <div className="p-4">
          <Button variant="outline" size="sm" disabled={isFetching} onClick={() => {
            const ultimo = data?.movimientos.at(-1)
            if (!ultimo) return
            setAnteriores(filas)
            setAntes(ultimo.id)
          }}>
            {isFetching ? 'Cargando…' : 'Ver más antiguos'}
          </Button>
        </div>
      )}
    </Card>
  )
}
