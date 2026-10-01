import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Badge } from '@botpanel/ui/components/badge'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@botpanel/ui/components/tabs'
import { getPagos, marcarLiquidacion } from './api'
import Registro from './Registro'
import type { CuentaBancaria, Liquidacion } from './api'

// ═══════════════════════════════════════════════════════════════════════════
// PAGOS — EL DINERO QUE ENTRA Y SALE DE UMBANI
// ═══════════════════════════════════════════════════════════════════════════
//
// Con la tarjeta, el dinero entra en la cuenta de Umbani y cada lunes se
// liquida a cada local; con el efectivo y la transferencia, el local tiene el
// dinero y debe la comisión, que se resta de su próximo depósito.
//
// ⚠️ Aquí NO se calcula ni un centavo: saldos, liquidaciones y cobros llegan
// calculados por PostgreSQL. Lo único que se escribe es «pagada» o «cobrada»,
// con la referencia de la transferencia.

const dinero = (centavos: number) =>
  (centavos < 0 ? '-$' : '$') + (Math.abs(centavos) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const semana = (desde: string, hasta: string) => {
  const f = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-EC', { day: '2-digit', month: 'short' })
  return `${f(desde)} – ${f(hasta)}`
}

const hora = (iso: string) => new Date(iso).toLocaleString('es-EC', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
})

const ESTADO_LIQUIDACION: Record<Liquidacion['status'], { texto: string; tono: string }> = {
  por_pagar: { texto: 'Por pagar al local', tono: 'bg-amber-500/10 text-amber-700 dark:text-amber-400' },
  por_cobrar: { texto: 'El local debe', tono: 'bg-red-500/10 text-red-700 dark:text-red-400' },
  en_cero: { texto: 'En cero', tono: 'bg-muted text-muted-foreground' },
  pagada: { texto: 'Pagada', tono: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  cobrada: { texto: 'Cobrada', tono: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  compensada: { texto: 'Pasó a la semana siguiente', tono: 'bg-muted text-muted-foreground' },
}

const ESTADO_COBRO: Record<string, string> = {
  iniciado: 'Pagando', confirmando: 'Confirmando', aprobado: 'Aprobado', rechazado: 'Rechazado',
  caducado: 'Sin pagar', no_confirmado: 'Devuelto por PayPhone', por_devolver: 'Por devolver',
  devuelto: 'Devuelto', devolucion_manual: 'Devolver a mano',
}

function Cuenta({ cuenta }: { cuenta: CuentaBancaria | undefined }) {
  if (!cuenta?.account_number) {
    return <span className="text-xs text-destructive">Sin cuenta bancaria en su panel</span>
  }
  return (
    <span className="text-xs text-muted-foreground">
      {cuenta.bank_name} · {cuenta.account_type} · <span className="font-mono text-foreground">{cuenta.account_number}</span>
      {' · '}{cuenta.holder_name}{cuenta.holder_id ? ` (${cuenta.holder_id})` : ''}
    </span>
  )
}

function Marcar({ liquidacion }: { liquidacion: Liquidacion }) {
  const qc = useQueryClient()
  const [referencia, setReferencia] = useState('')
  const marcar = useMutation({
    mutationFn: () => marcarLiquidacion(liquidacion.id, referencia.trim()),
    onSuccess: () => {
      toast.success(liquidacion.status === 'por_pagar' ? 'Marcada como pagada' : 'Marcada como cobrada')
      qc.invalidateQueries({ queryKey: ['adm-pagos'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <div className="flex items-center justify-end gap-2">
      <Input
        value={referencia}
        onChange={e => setReferencia(e.target.value)}
        placeholder="Referencia"
        aria-label="Referencia de la transferencia"
        className="h-8 w-36"
      />
      <Button size="sm" disabled={referencia.trim().length < 3 || marcar.isPending} onClick={() => marcar.mutate()}>
        {liquidacion.status === 'por_pagar' ? 'Pagada' : 'Cobrada'}
      </Button>
    </div>
  )
}

/** Local de demostración (2026-09-30): su dinero es de prueba y no se paga. */
const Demo = ({ demo }: { demo?: boolean }) => (demo
  ? <Badge variant="outline" className="ml-1.5 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-800 dark:text-amber-300">Demo</Badge>
  : null)

export default function Pagos() {
  const { data, isLoading, error } = useQuery({ queryKey: ['adm-pagos'], queryFn: getPagos })

  if (isLoading) return <Skeleton className="h-64 w-full" />
  if (error || !data) return <p className="text-sm text-destructive">No se pudieron cargar los pagos.</p>

  // ⚠️ Sin los locales de DEMOSTRACIÓN (2026-09-30): su dinero es de prueba, y
  // sumarlo haría creer que Umbani debe o gana lo que nunca existió.
  const reales = data.saldos.filter(s => !s.demo)
  const debemos = reales.filter(s => s.neto_cents > 0).reduce((t, s) => t + s.neto_cents, 0)
  const nosDeben = reales.filter(s => s.neto_cents < 0).reduce((t, s) => t - s.neto_cents, 0)
  const ganamos = reales.reduce((t, s) => t + s.umbani_cents - s.payphone_cents, 0)
  const pendientes = data.liquidaciones.filter(l => !l.demo && (l.status === 'por_pagar' || l.status === 'por_cobrar'))

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Pagos</h1>
        <p className="text-sm text-muted-foreground">
          Lo que Umbani cobró con tarjeta, lo que debe a cada local y lo que cada local debe. Cada lunes se liquida la semana anterior.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Umbani debe a los locales (semana en curso)</div>
          <div className="text-2xl font-bold tabular-nums text-foreground">{dinero(debemos)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Los locales deben a Umbani (semana en curso)</div>
          <div className="text-2xl font-bold tabular-nums text-foreground">{dinero(nosDeben)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Le queda a Umbani (comisión menos PayPhone estimado)</div>
          <div className="text-2xl font-bold tabular-nums text-primary">{dinero(ganamos)}</div>
        </Card>
      </div>

      <Tabs defaultValue={pendientes.length ? 'liquidaciones' : 'saldos'}>
        <TabsList>
          <TabsTrigger value="saldos">Semana en curso</TabsTrigger>
          <TabsTrigger value="liquidaciones">Liquidaciones{pendientes.length ? ` (${pendientes.length})` : ''}</TabsTrigger>
          <TabsTrigger value="cobros">Cobros con tarjeta</TabsTrigger>
          <TabsTrigger value="registro">Registro</TabsTrigger>
        </TabsList>

        <TabsContent value="saldos">
          <Card className="p-0">
            {data.saldos.length === 0
              ? <p className="p-6 text-sm text-muted-foreground">Todavía no hay pedidos entregados sin liquidar.</p>
              : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Local</TableHead>
                      <TableHead className="text-right">Pedidos</TableHead>
                      <TableHead className="text-right">Le corresponde</TableHead>
                      <TableHead className="text-right">Ya cobró él</TableHead>
                      <TableHead className="text-right">De antes</TableHead>
                      <TableHead className="text-right">Saldo</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.saldos.map(s => (
                      <TableRow key={s.business_id}>
                        <TableCell>
                          <div className="font-medium">{s.business_name}<Demo demo={s.demo} /></div>
                          {s.neto_cents > 0 && !s.demo && <Cuenta cuenta={data.cuentas[s.business_id]} />}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{s.pedidos} <span className="text-xs text-muted-foreground">({s.pedidos_tarjeta} con tarjeta)</span></TableCell>
                        <TableCell className="text-right tabular-nums">{dinero(s.derecho_cents)}</TableCell>
                        <TableCell className="text-right tabular-nums">{dinero(s.en_mano_cents)}</TableCell>
                        <TableCell className="text-right tabular-nums">{s.arrastre_cents ? dinero(s.arrastre_cents) : '—'}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {s.neto_cents >= 0 ? `Le debemos ${dinero(s.neto_cents)}` : `Nos debe ${dinero(-s.neto_cents)}`}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
          </Card>
        </TabsContent>

        <TabsContent value="liquidaciones">
          <Card className="p-0">
            {data.liquidaciones.length === 0
              ? <p className="p-6 text-sm text-muted-foreground">La primera liquidación sale el lunes, con la semana anterior.</p>
              : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Local</TableHead>
                      <TableHead>Semana</TableHead>
                      <TableHead className="text-right">Pedidos</TableHead>
                      <TableHead className="text-right">Cuota descontada</TableHead>
                      <TableHead className="text-right">Neto</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead className="text-right">Acción</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.liquidaciones.map(l => (
                      <TableRow key={l.id}>
                        <TableCell>
                          <div className="font-medium">{l.businesses?.name || '—'}<Demo demo={l.demo} /></div>
                          {l.status === 'por_pagar' && !l.demo && <Cuenta cuenta={data.cuentas[l.business_id]} />}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{semana(l.period_start, l.period_end)}</TableCell>
                        <TableCell className="text-right tabular-nums">{l.orders_count}</TableCell>
                        <TableCell className="text-right tabular-nums">{l.cuota_cents ? dinero(l.cuota_cents) : '—'}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{dinero(l.neto_cents)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={ESTADO_LIQUIDACION[l.status].tono}>{ESTADO_LIQUIDACION[l.status].texto}</Badge>
                          {l.reference && <div className="mt-1 text-xs text-muted-foreground">Ref. {l.reference}</div>}
                        </TableCell>
                        <TableCell className="text-right">
                          {l.demo
                            ? <span className="text-xs text-muted-foreground">Demo: no se paga</span>
                            : (l.status === 'por_pagar' || l.status === 'por_cobrar') ? <Marcar liquidacion={l} /> : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
          </Card>
        </TabsContent>

        <TabsContent value="cobros">
          <Card className="p-0">
            {data.cobros.length === 0
              ? <p className="p-6 text-sm text-muted-foreground">Todavía no hay cobros con tarjeta.</p>
              : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fecha</TableHead>
                      <TableHead>Local</TableHead>
                      <TableHead>Pedido</TableHead>
                      <TableHead className="text-right">Monto</TableHead>
                      <TableHead>Tarjeta</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Id PayPhone</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.cobros.map(c => (
                      <TableRow key={c.id}>
                        <TableCell className="whitespace-nowrap">{hora(c.created_at)}</TableCell>
                        <TableCell>{c.businesses?.name || '—'}<Demo demo={c.demo} /></TableCell>
                        <TableCell>#{c.orders?.order_number ?? '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{dinero(c.captured_cents ?? c.amount_cents)}</TableCell>
                        <TableCell className="whitespace-nowrap">{c.card_brand ? `${c.card_brand}${c.card_last_digits ? ` ···${c.card_last_digits}` : ''}` : '—'}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <span>{ESTADO_COBRO[c.status] || c.status}</span>
                            {c.environment === 'pruebas' && <Badge variant="outline" className="text-[10px]">Prueba</Badge>}
                          </div>
                          {c.status_detail && <div className="text-xs text-muted-foreground">{c.status_detail}</div>}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{c.provider_transaction_id || '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
          </Card>
        </TabsContent>

        {/* Quién movió dinero (2026-09-29). Radix solo lo monta al abrirlo. */}
        <TabsContent value="registro">
          <Registro />
        </TabsContent>
      </Tabs>
    </div>
  )
}
