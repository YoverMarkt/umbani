import { useQuery } from '@tanstack/react-query'
import { Receipt, ShieldAlert, TriangleAlert } from 'lucide-react'
import { money, getReceiptAnalysis, type Order, type ReceiptAnalysis } from './api'
import { Badge } from '@botpanel/ui/components/badge'

// Lo que leyó el análisis de un comprobante, en la tarjeta del pedido (vivía en
// Orders.tsx hasta el 2026-10-08: ningún archivo pasa de 1.000 líneas).

/**
 * Cómo se pinta cada banda del riesgo.
 *
 * ⚠️ El verde NO dice «este pago es bueno», dice «no encontramos señales».
 * Son cosas distintas y el aviso de arriba lo repite: un comprobante limpio
 * sigue siendo una imagen que pudo editarse, generarse o reutilizarse.
 */
const RIESGO: Record<string, { texto: string; clase: string }> = {
  bajo: {
    texto: 'Sin señales',
    clase: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  },
  medio: {
    texto: 'Riesgo medio',
    clase: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300',
  },
  alto: {
    texto: 'Riesgo alto',
    clase: 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-300',
  },
  critico: {
    texto: 'Riesgo crítico',
    clase: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-300',
  },
}

/** Una fila «etiqueta: valor» del análisis. Lo que no se leyó se dice así. */
const Dato = ({ etiqueta, valor }: { etiqueta: string; valor?: string | null }) => (
  <div className="min-w-0">
    <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{etiqueta}</dt>
    <dd className="truncate font-medium text-foreground">
      {valor || <span className="font-normal text-muted-foreground">no se leyó</span>}
    </dd>
  </div>
)

/**
 * ── LO QUE EL SISTEMA LEYÓ DEL COMPROBANTE ────────────────────────────────
 *
 * ⚠️ EL AVISO VA SIEMPRE, arriba y en todos los casos. No es un adorno legal:
 * es la diferencia entre una herramienta que ayuda a decidir y una que decide
 * por el dueño. Ningún score confirma que el dinero haya entrado — un
 * comprobante puede editarse, generarse con una plantilla o reutilizarse de
 * otro pedido, y todos esos casos se leen igual de bien.
 */
export function AnalisisDelComprobante({ pedido }: { pedido: Order }) {
  const { data, isLoading } = useQuery({
    queryKey: ['receipt-analysis', pedido.id, pedido.payment_proof_url],
    queryFn: () => getReceiptAnalysis(pedido.id),
    // ⚠️ `staleTime: Infinity` y no el refetch de 12 s de la lista: el análisis
    // de un comprobante NO cambia una vez escrito, así que colgarlo del
    // refresco sería una consulta por pedido y por minuto durante todo el
    // servicio para leer siempre lo mismo. Cuando el dueño pide otro
    // comprobante cambia `payment_proof_url`, y con él la clave: entonces sí
    // se vuelve a consultar, que es exactamente cuando hace falta.
    staleTime: Infinity,
    enabled: Boolean(pedido.payment_proof_url),
  })

  if (!pedido.payment_proof_url) return null
  if (isLoading || !data?.analisis) return null

  const analisis: ReceiptAnalysis = data.analisis
  const esperado = data.esperado
  const riesgo = RIESGO[analisis.risk_level || 'bajo'] || RIESGO.bajo
  const detectado = analisis.amount === null || analisis.amount === undefined
    ? null
    : Number(analisis.amount)
  // Se comparan en centavos para no arrastrar el error del coma flotante.
  const cuadra = detectado !== null
    && Math.round(detectado * 100) === Math.round(Number(pedido.total) * 100)
  const senales = (analisis.flags || []).filter(senal => senal.points > 0)

  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Receipt className="h-4 w-4 shrink-0" />
          Lectura del comprobante
        </div>
        {analisis.status === 'requiere_revision'
          ? (
              <Badge variant="outline" className="text-xs">No se pudo leer</Badge>
            )
          : (
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${riesgo.clase}`}>
                {riesgo.texto}
                {typeof analisis.risk_score === 'number' && ` · ${analisis.risk_score}/100`}
              </span>
            )}
      </div>

      {/* ⚠️ SIEMPRE, en todos los casos y sin excepción. */}
      <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Este análisis no confirma que el dinero haya ingresado.
          Verifica el movimiento bancario antes de aprobar.
        </span>
      </p>

      {analisis.status !== 'requiere_revision' && (
        <>
          {/* El valor va primero y aparte: es lo que el dueño mira. */}
          <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
            <span className="text-muted-foreground">Esperado {money(pedido.total)}</span>
            <span aria-hidden="true" className="text-muted-foreground">·</span>
            <span
              className={
                detectado === null
                  ? 'font-medium text-muted-foreground'
                  : cuadra
                    ? 'font-bold text-emerald-700 dark:text-emerald-400'
                    : 'font-bold text-red-700 dark:text-red-400'
              }
            >
              {detectado === null
                ? 'no se leyó el valor'
                : `Detectado ${money(detectado)}`}
            </span>
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            <Dato etiqueta="Banco" valor={analisis.bank_name} />
            <Dato
              etiqueta="Fecha"
              valor={[analisis.transaction_date, analisis.transaction_time]
                .filter(Boolean).join(' · ') || null}
            />
            <Dato etiqueta="Ordenante" valor={analisis.sender_name} />
            <Dato etiqueta="Beneficiario" valor={analisis.beneficiary_name} />
            <Dato etiqueta="Cuenta destino" valor={analisis.destination_account} />
            <Dato
              etiqueta="Referencia"
              valor={analisis.reference_number || analisis.transaction_number}
            />
          </dl>

          {/* La cuenta que el negocio publica, para poder comparar de un
              vistazo sin ir a Ajustes. */}
          {esperado?.account_number && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Tu cuenta: {esperado.bank_name ? `${esperado.bank_name} · ` : ''}
              {esperado.account_number}
              {esperado.holder_name ? ` · ${esperado.holder_name}` : ''}
            </p>
          )}
        </>
      )}

      {/* Las señales explican el número. Sin esto, un 78/100 es un número sin
          defensa delante de alguien que está decidiendo si entrega comida. */}
      {senales.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-border/60 pt-2">
          {senales.map(senal => (
            <li
              key={senal.flag_type}
              className={`flex items-start gap-1.5 text-xs ${
                senal.severity === 'critica'
                  ? 'font-medium text-red-700 dark:text-red-400'
                  : 'text-amber-700 dark:text-amber-400'
              }`}
            >
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{senal.description || senal.flag_type.replace(/_/g, ' ')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
