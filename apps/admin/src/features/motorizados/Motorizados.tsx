import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Badge } from '@botpanel/ui/components/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@botpanel/ui/components/dialog'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { api } from '../../api/client'
import { getClients } from '../clients/api'

// ═══════════════════════════════════════════════════════════════════════════
// MOTORIZADOS — quién reparte, cuánto efectivo lleva y su liquidación
// ═══════════════════════════════════════════════════════════════════════════
//
// Construido y APAGADO: ningún local reparte con Umbani hasta que se cambie
// «Quién reparte» en su ficha. El motorizado guarda el efectivo que cobra y
// liquida los lunes; con más de su tope no toma pedidos en efectivo.
// ⚠️ Aquí no se calcula nada: todo llega del servidor, en centavos.

type Semana = { pedidos: number; carrerasCents: number; efectivoCobradoCents: number; efectivoEncimaCents: number; deAntesCents: number }
type Motorizado = {
  id: string; phone: string; name: string; vehicle: string | null; fleet_business_id: string | null
  active: boolean; available: boolean; cash_limit_cents: number
  businesses?: { name: string } | null; semana: Semana | null
}
type Liquidacion = {
  id: string; period_start: string; period_end: string; orders_count: number
  derecho_cents: number; en_mano_cents: number; neto_cents: number; status: string
  reference: string | null; couriers?: { name: string } | null
}

type Carrera = {
  order_id: string; sold_at: string; reparto_cents: number; payment_method: string | null
  retenido: boolean; retenido_motivo: string | null
  orders?: { order_number: number | null } | null; businesses?: { name: string } | null
}

const dinero = (c: number) => (c < 0 ? '-$' : '$') + (Math.abs(c) / 100).toFixed(2)
const UMBANI = 'umbani'

export default function Motorizados() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['adm-motorizados'],
    queryFn: () => api<{ motorizados: Motorizado[]; liquidaciones: Liquidacion[] }>('/api/admin/motorizados'),
  })
  const locales = useQuery({ queryKey: ['adm-clients-min'], queryFn: getClients })
  const [f, setF] = useState({ nombre: '', telefono: '', vehiculo: '', flota: UMBANI, tope: '150' })
  const [refs, setRefs] = useState<Record<string, string>>({})
  const refrescar = () => qc.invalidateQueries({ queryKey: ['adm-motorizados'] })

  // ── Retener una carrera (2026-10-02) ──────────────────────────────────
  // Si se le cae la comida, responde quien la dejó caer: la carrera sale de su
  // liquidación y el local cobra igual. Solo los de Umbani tienen carrera
  // propia, y solo se retiene lo que aún no se liquidó. No se puede deshacer.
  const [viendo, setViendo] = useState<Motorizado | null>(null)
  const [motivo, setMotivo] = useState('')
  const [aRetener, setARetener] = useState<string | null>(null)
  const carreras = useQuery({
    queryKey: ['adm-motorizado-carreras', viendo?.id],
    queryFn: () => api<{ carreras: Carrera[] }>(`/api/admin/motorizados/${viendo!.id}/carreras`),
    enabled: Boolean(viendo),
  })
  const retener = useMutation({
    mutationFn: (pedidoId: string) => api('/api/admin/motorizados/retener', {
      method: 'POST', body: JSON.stringify({ pedidoId, motivo }),
    }),
    onSuccess: () => {
      toast.success('Carrera retenida: no se le pagará en su liquidación')
      setARetener(null); setMotivo('')
      qc.invalidateQueries({ queryKey: ['adm-motorizado-carreras'] })
      refrescar()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const crear = useMutation({
    mutationFn: () => api('/api/admin/motorizados', { method: 'POST', body: JSON.stringify({
      nombre: f.nombre, telefono: f.telefono, vehiculo: f.vehiculo,
      flotaLocalId: f.flota === UMBANI ? null : f.flota, topeEfectivo: f.tope,
    }) }),
    onSuccess: () => { toast.success('Motorizado registrado'); setF({ ...f, nombre: '', telefono: '', vehiculo: '' }); refrescar() },
    onError: (e: Error) => toast.error(e.message),
  })
  const activar = useMutation({
    mutationFn: (m: Motorizado) => api(`/api/admin/motorizados/${m.id}/activo`, { method: 'PUT', body: JSON.stringify({ activo: !m.active }) }),
    onSuccess: refrescar,
    onError: (e: Error) => toast.error(e.message),
  })
  const marcar = useMutation({
    mutationFn: (id: string) => api(`/api/admin/motorizados/liquidaciones/${id}/marcar`, { method: 'POST', body: JSON.stringify({ referencia: refs[id] || '' }) }),
    onSuccess: () => { toast.success('Liquidación marcada'); refrescar() },
    onError: (e: Error) => toast.error(e.message),
  })

  if (isLoading || !data) return <Skeleton className="h-64 w-full" />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Motorizados</h1>
        <p className="text-sm text-muted-foreground">
          Los motorizados de Umbani guardan el efectivo que cobran y liquidan cada lunes. Solo llevan pedidos
          de los locales que tienen «Quién reparte: Umbani» en su ficha. Los de la flota de un local solo llevan los de ese local.
        </p>
      </div>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Registrar un motorizado</h2>
        <div className="grid gap-3 sm:grid-cols-5">
          <div><Label htmlFor="moto-nombre">Nombre</Label><Input id="moto-nombre" value={f.nombre} onChange={e => setF({ ...f, nombre: e.target.value })} /></div>
          <div><Label htmlFor="moto-tel">Teléfono (WhatsApp)</Label><Input id="moto-tel" inputMode="tel" value={f.telefono} onChange={e => setF({ ...f, telefono: e.target.value })} placeholder="593991234567" /></div>
          <div><Label htmlFor="moto-veh">Vehículo</Label><Input id="moto-veh" value={f.vehiculo} onChange={e => setF({ ...f, vehiculo: e.target.value })} placeholder="Moto ABC-123" /></div>
          <div>
            <Label htmlFor="moto-flota">Flota</Label>
            <Select value={f.flota} onValueChange={v => setF({ ...f, flota: v })}>
              <SelectTrigger id="moto-flota" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={UMBANI}>Umbani</SelectItem>
                {(locales.data || []).map(l => <SelectItem key={l.id} value={l.id}>De {l.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div><Label htmlFor="moto-tope">Tope de efectivo (USD)</Label><Input id="moto-tope" inputMode="decimal" value={f.tope} onChange={e => setF({ ...f, tope: e.target.value })} /></div>
        </div>
        <Button className="mt-3" disabled={crear.isPending || f.nombre.trim().length < 2 || f.telefono.trim().length < 8} onClick={() => crear.mutate()}>
          Registrar
        </Button>
      </Card>

      <Card className="p-0">
        {data.motorizados.length === 0
          ? <p className="p-6 text-sm text-muted-foreground">Todavía no hay motorizados registrados.</p>
          : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Motorizado</TableHead>
                  <TableHead>Flota</TableHead>
                  <TableHead className="text-right">Efectivo encima</TableHead>
                  <TableHead className="text-right">Carreras (semana)</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Acción</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.motorizados.map(m => (
                  <TableRow key={m.id}>
                    <TableCell><div className="font-medium">{m.name}</div><div className="text-xs text-muted-foreground">{m.phone}{m.vehicle ? ` · ${m.vehicle}` : ''}</div></TableCell>
                    <TableCell>{m.fleet_business_id ? `De ${m.businesses?.name || 'un local'}` : 'Umbani'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {dinero(m.semana?.efectivoEncimaCents ?? 0)} <span className="text-xs text-muted-foreground">/ {dinero(m.cash_limit_cents)}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{dinero(m.semana?.carrerasCents ?? 0)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{!m.active ? 'Inactivo' : m.available ? 'Disponible' : 'No disponible'}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {/* Solo los de Umbani: la carrera de la flota de un local es del local. */}
                        {!m.fleet_business_id && (
                          <Button size="sm" variant="outline" onClick={() => { setViendo(m); setARetener(null); setMotivo('') }}>Carreras</Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => activar.mutate(m)}>{m.active ? 'Desactivar' : 'Activar'}</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </Card>

      <Card className="p-0">
        <h2 className="px-4 pt-4 text-sm font-semibold text-foreground">Liquidaciones de motorizados</h2>
        {data.liquidaciones.length === 0
          ? <p className="p-4 text-sm text-muted-foreground">La primera sale el lunes después de su primera semana.</p>
          : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Motorizado</TableHead>
                  <TableHead>Semana</TableHead>
                  <TableHead className="text-right">Carreras</TableHead>
                  <TableHead className="text-right">Efectivo cobrado</TableHead>
                  <TableHead className="text-right">Neto</TableHead>
                  <TableHead className="text-right">Acción</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.liquidaciones.map(l => (
                  <TableRow key={l.id}>
                    <TableCell>{l.couriers?.name || '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">{l.period_start} → {l.period_end}</TableCell>
                    <TableCell className="text-right tabular-nums">{dinero(l.derecho_cents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{dinero(l.en_mano_cents)}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {l.neto_cents >= 0 ? `Le pagamos ${dinero(l.neto_cents)}` : `Nos debe ${dinero(-l.neto_cents)}`}
                    </TableCell>
                    <TableCell className="text-right">
                      {(l.status === 'por_pagar' || l.status === 'por_cobrar')
                        ? (
                          <div className="flex items-center justify-end gap-2">
                            <Input className="h-8 w-32" placeholder="Referencia" aria-label="Referencia"
                              value={refs[l.id] || ''} onChange={e => setRefs({ ...refs, [l.id]: e.target.value })} />
                            <Button size="sm" disabled={(refs[l.id] || '').trim().length < 3} onClick={() => marcar.mutate(l.id)}>
                              {l.status === 'por_pagar' ? 'Pagada' : 'Cobrada'}
                            </Button>
                          </div>
                        )
                        : <span className="text-xs text-muted-foreground">{l.status}{l.reference ? ` · ${l.reference}` : ''}</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </Card>

      <Dialog open={Boolean(viendo)} onOpenChange={abierto => { if (!abierto) setViendo(null) }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Carreras de {viendo?.name}</DialogTitle>
            <DialogDescription>
              Las que aún no se liquidaron. Retener una la quita de su liquidación (se le cayó la comida):
              el local cobra igual. No se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          {carreras.isLoading
            ? <Skeleton className="h-24 w-full" />
            : (carreras.data?.carreras || []).length === 0
              ? <p className="text-sm text-muted-foreground">No tiene carreras pendientes de liquidar.</p>
              : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Pedido</TableHead>
                      <TableHead className="text-right">Carrera</TableHead>
                      <TableHead className="text-right">Acción</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(carreras.data?.carreras || []).map(c => (
                      <TableRow key={c.order_id}>
                        <TableCell>
                          <div className="font-medium">#{c.orders?.order_number ?? '—'} · {c.businesses?.name || 'Local'}</div>
                          <div className="text-xs text-muted-foreground">{new Date(c.sold_at).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}</div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{dinero(c.reparto_cents)}</TableCell>
                        <TableCell className="text-right">
                          {c.retenido
                            ? <Badge variant="outline" title={c.retenido_motivo || ''}>Retenida</Badge>
                            : aRetener === c.order_id
                              ? (
                                <div className="flex items-center justify-end gap-2">
                                  <Input className="h-8 w-48" placeholder="Motivo (obligatorio)" aria-label="Motivo de la retención"
                                    value={motivo} onChange={e => setMotivo(e.target.value)} />
                                  <Button size="sm" variant="destructive" disabled={motivo.trim().length < 3 || retener.isPending}
                                    onClick={() => retener.mutate(c.order_id)}>Retener</Button>
                                  <Button size="sm" variant="ghost" onClick={() => { setARetener(null); setMotivo('') }}>Cancelar</Button>
                                </div>
                              )
                              : <Button size="sm" variant="outline" onClick={() => { setARetener(c.order_id); setMotivo('') }}>Retener…</Button>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
