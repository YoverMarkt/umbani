import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@botpanel/ui/components/button'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { levantarSoloAdelantado, type Incidencia } from './api'

// ═══════════════════════════════════════════════════════════════════════════
// EL CLIENTE QUE NO ESTABA: SOLO POR ADELANTADO, NO BLOQUEADO (2026-10-12)
// ═══════════════════════════════════════════════════════════════════════════
//
// Decisión del dueño, «como las grandes»: al que no estaba para recibir su
// pedido ya no se le bloquea. Durante unos días (90 por defecto) la app solo
// le ofrece tarjeta o transferencia, sin explicarle la regla. Aquí el
// superadmin ve hasta cuándo y lo puede levantar antes. La fecha la pone y la
// hace cumplir la base; esta tarjeta solo la enseña.

const dia = (iso: string) => new Date(iso).toLocaleDateString('es-EC', { day: 'numeric', month: 'short', year: 'numeric' })

export default function SoloPorAdelantado({ incidencia }: { incidencia: Incidencia }) {
  const qc = useQueryClient()
  const levantar = useMutation({
    mutationFn: () => levantarSoloAdelantado(incidencia.id),
    onSuccess: () => {
      toast.success('Listo: el cliente ya puede pagar como quiera')
      void qc.invalidateQueries({ queryKey: ['incidencias'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const hasta = incidencia.soloPorAdelantadoHasta
  if (!hasta) return null
  const levantada = incidencia.restriccionLevantada
  if (levantada) {
    return (
      <p className="text-sm text-muted-foreground">
        Umbani le levantó el «solo por adelantado» el {dia(levantada.en)}{levantada.por ? ` (${levantada.por})` : ''}.
      </p>
    )
  }
  if (new Date(hasta).getTime() <= Date.now()) {
    return <p className="text-sm text-muted-foreground">Ya puede pagar como quiera: el «solo por adelantado» terminó el {dia(hasta)}.</p>
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted px-3 py-2 text-sm">
      <span>Este cliente solo puede pagar por adelantado hasta el <strong>{dia(hasta)}</strong>.</span>
      <ConfirmAction
        trigger={<Button size="sm" variant="outline" disabled={levantar.isPending}>Levantarlo ya</Button>}
        title="¿Levantar el «solo por adelantado»?"
        description="El cliente vuelve a poder pagar en efectivo desde ya. Queda anotado que lo hiciste tú."
        confirmLabel="Levantarlo"
        onConfirm={() => levantar.mutate()}
      />
    </div>
  )
}
