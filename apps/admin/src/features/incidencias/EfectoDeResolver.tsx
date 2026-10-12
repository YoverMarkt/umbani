import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { getEfecto, type Ajuste, type Incidencia, type Responsable } from './api'

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE PASARÁ EN LAS LIQUIDACIONES (2026-10-12, parte 3)
// ═══════════════════════════════════════════════════════════════════════════
//
// Antes de confirmar, el superadmin ve a quién se le descuenta o reconoce
// cuánto el lunes. Lo calcula la MISMA función de la base que lo aplica al
// resolver: el número que se ve aquí es el que se cobra.

const dinero = (centavos: number) => `$${(Math.abs(centavos) / 100).toFixed(2)}`

const QUE_ES: Record<Ajuste['concepto'], string> = {
  reclamo: 'lo devuelto al cliente, menos la comisión de Umbani',
  no_cobro: 'el efectivo que no llegó a cobrar',
  comida_reconocida: 'la comida que perdió',
  comida_cobrada: 'la comida que se perdió',
}

/**
 * Por qué. En un pedido que NO LLEGÓ el «reclamo» no es lo devuelto: si iba
 * en efectivo el cliente no pagó ni recibió nada, y lo que se cobra es el
 * valor del pedido menos la comisión de Umbani (la comida y el envío).
 */
const queEs = (a: Ajuste, i: Incidencia) => (
  a.concepto === 'reclamo' && i.tipo === 'no_llego' ? 'el pedido que no llegó, menos la comisión de Umbani' : QUE_ES[a.concepto]
)

const aQuien = (a: Ajuste, i: Incidencia) => (
  a.parte === 'local'
    ? `Al local${i.local.nombre ? ` ${i.local.nombre}` : ''}`
    : `Al repartidor${i.repartidor ? ` ${i.repartidor.nombre}` : ''}`
)

/** «Al local Monster Pizza se le descontarán $9.00 el lunes: lo devuelto…» */
function frase(a: Ajuste, i: Incidencia) {
  if (a.concepto === 'no_cobro') {
    return `${aQuien(a, i)} se le quitan ${dinero(a.cents)} del efectivo cobrado: el libro decía que los cobró y el pedido no llegó.`
  }
  return `${aQuien(a, i)} se le ${a.cents < 0 ? 'descontarán' : 'pagarán'} ${dinero(a.cents)} el lunes: ${queEs(a, i)}.`
}

/** Lo que ya se aplicó, en la tarjeta de una resuelta. */
export function AjustesAplicados({ incidencia }: { incidencia: Incidencia }) {
  if (!incidencia.ajustes?.length) return null
  return (
    <ul className="space-y-0.5 text-sm">
      {incidencia.ajustes.map(a => (
        <li key={`${a.parte}-${a.concepto}`} className="flex justify-between gap-3">
          <span className="text-muted-foreground">
            {a.parte === 'local' ? 'Local' : 'Repartidor'} · {queEs(a, incidencia)}
          </span>
          <span className="shrink-0 tabular-nums">{a.cents < 0 ? '−' : '+'}{dinero(a.cents)}</span>
        </li>
      ))}
    </ul>
  )
}

/** La vista previa del diálogo: con monto inválido (`null`) no pregunta. */
export function EfectoDeResolver({ incidencia, responsable, compensacionCents }: {
  incidencia: Incidencia
  responsable: Responsable
  compensacionCents: number | null
}) {
  // Mientras escribe el monto no se pregunta en cada tecla: 300 ms de calma.
  const [cents, setCents] = useState(compensacionCents)
  useEffect(() => {
    const espera = setTimeout(() => setCents(compensacionCents), 300)
    return () => clearTimeout(espera)
  }, [compensacionCents])

  const efecto = useQuery({
    queryKey: ['incidencia-efecto', incidencia.id, responsable, cents],
    queryFn: () => getEfecto(incidencia.id, responsable, cents ?? 0),
    enabled: cents !== null,
    // Al cambiar de responsable no parpadea: se ve lo anterior hasta que llega lo nuevo.
    placeholderData: anterior => anterior,
  })

  if (compensacionCents === null) return null
  if (efecto.isError) {
    return <p className="text-xs text-destructive">No pudimos calcular qué pasará en las liquidaciones. Revisa el monto.</p>
  }
  if (!efecto.data) return <Skeleton className="h-12 w-full" />
  const { ajustes, bloquea } = efecto.data
  return (
    <div className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
      <div className="font-medium text-foreground">Al resolver</div>
      {ajustes.length
        ? ajustes.map(a => <p key={`${a.parte}-${a.concepto}`}>{frase(a, incidencia)}</p>)
        : <p className="text-muted-foreground">{responsable === 'umbani' ? 'Lo pone Umbani: no cambia la liquidación de nadie.' : 'No cambia la liquidación de nadie.'}</p>}
      {bloquea && <p className="font-medium text-destructive">El cliente quedará bloqueado en Umbani: no podrá hacer más pedidos.</p>}
    </div>
  )
}
