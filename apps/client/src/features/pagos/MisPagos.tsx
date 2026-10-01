import { useQuery } from '@tanstack/react-query'
import { Check, CreditCard, Landmark, Banknote, Wallet } from 'lucide-react'
import { Badge } from '@botpanel/ui/components/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@botpanel/ui/components/card'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { api } from '../../api/client'

// ═══════════════════════════════════════════════════════════════════════════
// MIS PAGOS — EL ESTADO DE CUENTA DEL LOCAL
// ═══════════════════════════════════════════════════════════════════════════
//
// Como las grandes: Umbani cobra los pedidos con tarjeta y le deposita al
// local cada lunes lo de la semana anterior. Lo que el local cobra él mismo
// (efectivo, transferencia) ya lo tiene en la mano, así que la comisión de
// esos pedidos se descuenta del depósito.
//
// ⚠️ Aquí NO se calcula ni un centavo: todo llega calculado por el servidor
// (el libro y el cierre semanal viven en PostgreSQL). Esta pantalla pinta.
//
// ⚠️ Entra en el menú por pedido del dueño de Umbani, aunque Reportes dejó
// escrito que el menú no crece: es SOLO para el dueño del local, y solo en los
// locales que venden.

type Semana = {
  pedidos: number
  pedidosTarjeta: number
  tuyoCents: number
  yaCobrasteCents: number
  deAntesCents: number
  comisionCents: number
  netoCents: number
}
type Pedido = {
  numero: number | null
  fecha: string
  tipo: 'venta' | 'reverso'
  metodo: string | null
  totalCents: number
  tuyoCents: number
  comisionCents: number
  cobro: 'tu' | 'umbani'
}
type Deposito = {
  id: string
  desde: string
  hasta: string
  pedidos: number
  tuyoCents: number
  yaCobrasteCents: number
  deAntesCents: number
  cuotaCents: number
  netoCents: number
  estado: 'por_pagar' | 'por_cobrar' | 'en_cero' | 'pagada' | 'cobrada' | 'compensada'
  pagadoEl: string | null
  referencia: string | null
}
type MisPagosData = { semana: Semana; pedidos: Pedido[]; depositos: Deposito[]; demo?: boolean }

const dinero = (centavos: number) =>
  '$' + (Math.abs(centavos) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const dia = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00` : iso)
  .toLocaleDateString('es-EC', { day: '2-digit', month: 'short' })

const METODO: Record<string, { texto: string; icono: typeof CreditCard }> = {
  tarjeta: { texto: 'Tarjeta', icono: CreditCard },
  transferencia: { texto: 'Transferencia', icono: Landmark },
  efectivo: { texto: 'Efectivo', icono: Banknote },
  pago_al_retirar: { texto: 'Al retirar', icono: Banknote },
}

const ESTADO: Record<Deposito['estado'], { texto: string; tono: string }> = {
  por_pagar: { texto: 'Umbani te deposita', tono: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  pagada: { texto: 'Depositado', tono: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  por_cobrar: { texto: 'Debes a Umbani', tono: 'bg-red-500/10 text-red-700 dark:text-red-400' },
  cobrada: { texto: 'Pagado a Umbani', tono: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  compensada: { texto: 'Pasó a la semana siguiente', tono: 'bg-muted text-muted-foreground' },
  en_cero: { texto: 'En cero', tono: 'bg-muted text-muted-foreground' },
}

export default function MisPagos() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['mis-pagos'],
    queryFn: () => api<MisPagosData>('/api/client/mis-pagos'),
  })

  if (isLoading) return <Skeleton className="h-64 w-full" />
  if (error || !data) return <QueryError onRetry={() => refetch()} />

  const s = data.semana
  const aFavor = s.netoCents >= 0

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Mis pagos</h1>
        <p className="text-sm text-muted-foreground">
          Umbani cobra tus pedidos con tarjeta y te deposita cada lunes lo de la semana anterior.
          Lo que cobras tú en efectivo o transferencia ya lo tienes; su comisión se descuenta del depósito.
        </p>
        {data?.demo && (
          <p className="mt-2 text-sm font-medium text-amber-800 dark:text-amber-300">
            Estado de cuenta de ejemplo: así se ve el de un local real, pero estos montos no se depositan.
          </p>
        )}
      </div>

      <Card className="border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="size-4 shrink-0 text-primary" />
            Esta semana
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-4">
            <div>
              <div className="text-xs text-muted-foreground">Te corresponde</div>
              <div className="text-xl font-bold tabular-nums text-foreground">{dinero(s.tuyoCents)}</div>
              <div className="text-xs text-muted-foreground">{s.pedidos} pedidos entregados · tus productos y el envío</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Ya cobraste tú</div>
              <div className="text-xl font-bold tabular-nums text-foreground">{dinero(s.yaCobrasteCents)}</div>
              <div className="text-xs text-muted-foreground">efectivo y transferencias</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Comisión Umbani</div>
              <div className="text-xl font-bold tabular-nums text-foreground">{dinero(s.comisionCents)}</div>
              <div className="text-xs text-muted-foreground">la pagó el cliente, sobre tus precios</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{aFavor ? 'Umbani te deposita' : 'Debes a Umbani'}</div>
              <div className={`text-2xl font-extrabold tabular-nums ${aFavor ? 'text-primary' : 'text-destructive'}`}>
                {dinero(s.netoCents)}
              </div>
              <div className="text-xs text-muted-foreground">
                {aFavor ? 'el próximo lunes' : 'se descuenta de tus próximos depósitos'}
              </div>
            </div>
          </div>
          {s.deAntesCents !== 0 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Incluye {dinero(s.deAntesCents)} {s.deAntesCents < 0 ? 'que debías' : 'a tu favor'} de semanas anteriores.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Pedidos de esta semana</CardTitle></CardHeader>
        <CardContent className="p-0">
          {data.pedidos.length === 0
            ? <p className="px-6 pb-6 text-sm text-muted-foreground">Todavía no hay pedidos entregados esta semana.</p>
            : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Pedido</TableHead>
                    <TableHead>Pago</TableHead>
                    <TableHead className="text-right">Pagó el cliente</TableHead>
                    <TableHead className="text-right">Comisión</TableHead>
                    <TableHead className="text-right">Tuyo</TableHead>
                    <TableHead>Quién cobró</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.pedidos.map((p, i) => {
                    const metodo = METODO[p.metodo || ''] || { texto: 'Por coordinar', icono: Banknote }
                    const Icono = metodo.icono
                    return (
                      <TableRow key={`${p.numero}-${p.tipo}-${i}`}>
                        <TableCell>
                          <div className="font-medium">#{p.numero ?? '—'}{p.tipo === 'reverso' ? ' · anulado' : ''}</div>
                          <div className="text-xs text-muted-foreground">{dia(p.fecha)}</div>
                        </TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-1.5"><Icono className="size-3.5 text-muted-foreground" />{metodo.texto}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{dinero(p.totalCents)}</TableCell>
                        <TableCell className="text-right tabular-nums">{dinero(p.comisionCents)}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{dinero(p.tuyoCents)}</TableCell>
                        <TableCell className="text-sm">{p.cobro === 'tu' ? 'Tú' : 'Umbani'}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Depósitos</CardTitle></CardHeader>
        <CardContent className="p-0">
          {data.depositos.length === 0
            ? <p className="px-6 pb-6 text-sm text-muted-foreground">Tu primer depósito sale el lunes, con la semana anterior.</p>
            : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Semana</TableHead>
                    <TableHead className="text-right">Pedidos</TableHead>
                    <TableHead className="text-right">Te correspondía</TableHead>
                    <TableHead className="text-right">Ya cobrado</TableHead>
                    <TableHead className="text-right">Cuota descontada</TableHead>
                    <TableHead className="text-right">Neto</TableHead>
                    <TableHead>Estado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.depositos.map(d => (
                    <TableRow key={d.id}>
                      <TableCell className="whitespace-nowrap">{dia(d.desde)} – {dia(d.hasta)}</TableCell>
                      <TableCell className="text-right tabular-nums">{d.pedidos}</TableCell>
                      <TableCell className="text-right tabular-nums">{dinero(d.tuyoCents)}</TableCell>
                      <TableCell className="text-right tabular-nums">{dinero(d.yaCobrasteCents)}</TableCell>
                      <TableCell className="text-right tabular-nums">{d.cuotaCents ? dinero(d.cuotaCents) : '—'}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{dinero(d.netoCents)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={ESTADO[d.estado].tono}>
                          {(d.estado === 'pagada' || d.estado === 'cobrada') && <Check className="size-3" />}
                          {ESTADO[d.estado].texto}
                        </Badge>
                        {d.referencia && <div className="mt-1 text-xs text-muted-foreground">Ref. {d.referencia}</div>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
        </CardContent>
      </Card>
    </div>
  )
}
