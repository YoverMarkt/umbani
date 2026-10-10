import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Badge } from '@botpanel/ui/components/badge'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@botpanel/ui/components/dialog'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Textarea } from '@botpanel/ui/components/textarea'
import { getClients } from '../clients/api'
import {
  MOTIVOS, QUIEN_RESPONDE, RESPONSABLES, TIPOS, getIncidencias, registrarIncidencia, resolverIncidencia,
  type Incidencia, type Responsable, type TipoDeIncidencia,
} from './api'

// ═══════════════════════════════════════════════════════════════════════════
// INCIDENCIAS — «¿Llegó todo bien?» y lo que sale mal (2026-10-06, fase 1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Como las grandes: primero se le resuelve al cliente y después se decide
// quién responde. Llegan los reclamos de los clientes (faltó algo, vino mal,
// no llegó) y aquí se registran los que el cliente no ve (comida caída,
// cliente ausente, accidente, el repartidor que no apareció).
// ⚠️ Fase 1: la compensación queda decidida y anotada, NO mueve dinero. El
// saldo Umbani y el descuento en la liquidación llegan en la fase 2.

const dinero = (centavos: number | null | undefined) => `$${((centavos ?? 0) / 100).toFixed(2)}`
const fecha = (iso: string) => new Date(iso).toLocaleString('es-EC', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const ESTADO = { abierta: 'Abierta', compensada: 'Saldo dado', resuelta: 'Resuelta', descartada: 'Descartada' } as const
/** Las que le tocan al superadmin: decidir, o confirmar quién responde de un saldo ya dado. */
const pendiente = (i: Incidencia) => i.estado === 'abierta' || i.estado === 'compensada'

export default function Incidencias() {
  const qc = useQueryClient()
  const [ver, setVer] = useState<'abierta' | 'todas'>('abierta')
  const consulta = useQuery({ queryKey: ['incidencias', ver], queryFn: () => getIncidencias(ver) })
  const locales = useQuery({ queryKey: ['adm-clients-min'], queryFn: getClients })
  const refrescar = () => qc.invalidateQueries({ queryKey: ['incidencias'] })

  // Resolver: el responsable sale propuesto por la tabla aprobada, y la
  // compensación, con lo que calculó la base. Se cambian si hace falta.
  const [resolviendo, setResolviendo] = useState<Incidencia | null>(null)
  const [decision, setDecision] = useState({ estado: 'resuelta' as 'resuelta' | 'descartada', responsable: 'local' as Responsable, compensacion: '', nota: '' })
  const abrirResolver = (i: Incidencia) => {
    setResolviendo(i)
    // Si el saldo ya se dio al instante, el monto es ese y no cambia.
    const cents = i.estado === 'compensada' ? (i.compensacionCents ?? 0) : i.sugeridoCents
    setDecision({ estado: 'resuelta', responsable: QUIEN_RESPONDE[i.tipo], compensacion: (cents / 100).toFixed(2), nota: '' })
  }
  const resolver = useMutation({
    mutationFn: () => resolverIncidencia(resolviendo!.id, {
      estado: decision.estado,
      responsable: decision.estado === 'resuelta' ? decision.responsable : null,
      compensacionCents: decision.estado === 'resuelta' ? Math.round((Number(decision.compensacion.replace(',', '.')) || 0) * 100) : null,
      nota: decision.nota.trim(),
    }),
    onSuccess: (r: { saldoCents?: number }) => {
      toast.success(r?.saldoCents ? `Listo: el cliente recibió ${dinero(r.saldoCents)} de saldo Umbani` : 'Incidencia cerrada')
      setResolviendo(null)
      refrescar()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  // Registrar una que el cliente no ve.
  const [registrando, setRegistrando] = useState(false)
  const [nueva, setNueva] = useState({ localId: '', numero: '', tipo: 'comida_caida' as TipoDeIncidencia, nota: '' })
  const registrar = useMutation({
    mutationFn: () => registrarIncidencia({ localId: nueva.localId, numero: Number(nueva.numero), tipo: nueva.tipo, nota: nueva.nota.trim() }),
    onSuccess: () => {
      toast.success('Incidencia registrada')
      setRegistrando(false)
      setNueva({ localId: '', numero: '', tipo: 'comida_caida', nota: '' })
      refrescar()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  if (consulta.isError) return <QueryError onRetry={() => consulta.refetch()} />

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold text-foreground">Incidencias</h1>
          <p className="text-sm text-muted-foreground">
            Lo que el cliente reporta en «¿Llegó todo bien?» y lo que registras tú. Primero se le resuelve al
            cliente; después se decide quién responde. Por ahora la compensación queda anotada: el saldo Umbani y el
            descuento en la liquidación del lunes llegan en la fase 2.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant={ver === 'abierta' ? 'default' : 'outline'} size="sm" onClick={() => setVer('abierta')}>Abiertas</Button>
          <Button variant={ver === 'todas' ? 'default' : 'outline'} size="sm" onClick={() => setVer('todas')}>Todas</Button>
          <Button variant="outline" size="sm" onClick={() => setRegistrando(true)}>Registrar</Button>
        </div>
      </div>

      {!consulta.data
        ? <Skeleton className="h-48 w-full" />
        : !consulta.data.length
          ? <Card className="p-4 text-sm text-muted-foreground">{ver === 'abierta' ? 'No hay incidencias abiertas.' : 'Todavía no hay incidencias.'}</Card>
          : (
            <div className="space-y-3">
              {consulta.data.map(i => (
                <Card key={i.id} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-foreground">
                        {i.pedido.numero ? `#${i.pedido.numero}` : 'Pedido'} · {i.local.nombre || 'Local'}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {fecha(i.creadaEn)} · {i.origen === 'cliente' ? 'Lo reportó el cliente' : 'Registrada por el superadmin'}
                        {i.pedido.pago ? ` · pagó con ${i.pedido.pago}` : ''} · total {dinero(i.pedido.totalCents)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{TIPOS[i.tipo]}</Badge>
                      <Badge variant={pendiente(i) ? 'default' : 'secondary'}>{ESTADO[i.estado]}</Badge>
                    </div>
                  </div>

                  <div className="grid gap-1 text-sm sm:grid-cols-2">
                    {(i.pedido.cliente || i.pedido.telefono) && (
                      <div><span className="text-muted-foreground">Cliente: </span>{[i.pedido.cliente, i.pedido.telefono].filter(Boolean).join(' · ')}</div>
                    )}
                    <div>
                      <span className="text-muted-foreground">Lo llevó: </span>
                      {i.repartidor ? `${i.repartidor.nombre}${i.repartidor.cooperativa ? ` (${i.repartidor.cooperativa})` : ''}` : 'el local (sin repartidor de la app)'}
                    </div>
                  </div>

                  {i.lineas.length > 0 && (
                    <ul className="space-y-0.5 text-sm">
                      {i.lineas.map((l, n) => (
                        <li key={n} className="flex justify-between gap-3">
                          <span>{l.cantidad} × {l.nombre}</span>
                          <span className="tabular-nums">{dinero(l.centavos)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {i.nota && <p className="rounded-md bg-muted px-3 py-2 text-sm">«{i.nota}»</p>}
                  {i.fotoUrl && (
                    <a href={i.fotoUrl} target="_blank" rel="noreferrer" className="block w-fit">
                      <img src={i.fotoUrl} alt="Foto que mandó el cliente" className="h-28 rounded-md border object-cover" />
                    </a>
                  )}
                  {i.estado === 'abierta' && i.motivos.length > 0 && (
                    <div className="text-sm">
                      <span className="text-muted-foreground">No salió al instante: </span>
                      {i.motivos.map(m => MOTIVOS[m] || m).join(' · ')}
                      {i.escalon && i.escalon > 1 ? <span className="text-muted-foreground"> · escalón {i.escalon}</span> : null}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm">
                    {i.estado === 'compensada'
                      ? <span>Saldo dado al instante: <strong className="tabular-nums">{dinero(i.compensacionCents)}</strong> · falta confirmar quién responde</span>
                      : i.estado === 'abierta'
                      ? <span>Le corresponde, según la base: <strong className="tabular-nums">{dinero(i.sugeridoCents)}</strong></span>
                      : (
                        <span className="text-muted-foreground">
                          {i.estado === 'resuelta'
                            ? <>Responde {RESPONSABLES[i.responsable!].toLowerCase()} · compensación <strong className="text-foreground">{dinero(i.compensacionCents)}</strong></>
                            : 'Descartada'}
                          {i.resolucion ? ` · «${i.resolucion}»` : ''}
                        </span>
                      )}
                    {pendiente(i) && (
                      <Button size="sm" onClick={() => abrirResolver(i)}>{i.estado === 'compensada' ? 'Confirmar' : 'Resolver'}</Button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}

      <Dialog open={Boolean(resolviendo)} onOpenChange={abierto => { if (!abierto) setResolviendo(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolver {resolviendo?.pedido.numero ? `#${resolviendo.pedido.numero}` : 'la incidencia'}</DialogTitle>
            <DialogDescription>
              {resolviendo ? TIPOS[resolviendo.tipo] : ''}. Una resuelta no se reescribe: de ella cuelga el saldo del cliente y, el lunes, el cobro a quien responde.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div>
              <Label htmlFor="inc-estado">Qué se decide</Label>
              <Select value={decision.estado} onValueChange={v => setDecision({ ...decision, estado: v as 'resuelta' | 'descartada' })}>
                <SelectTrigger id="inc-estado" className="mt-1 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="resuelta">Resolver: alguien responde</SelectItem>
                  <SelectItem value="descartada">
                    {resolviendo?.estado === 'compensada' ? 'Descartar: no se le cree (el saldo se queda)' : 'Descartar: no hubo problema'}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {decision.estado === 'resuelta' && (
              <>
                <div>
                  <Label htmlFor="inc-responsable">Quién responde</Label>
                  <Select value={decision.responsable} onValueChange={v => setDecision({
                    ...decision,
                    responsable: v as Responsable,
                    // Si responde el cliente de lo que dijo no recibir, no hay nada que devolverle.
                    ...(v === 'cliente' && resolviendo?.estado === 'abierta' ? { compensacion: '0.00' } : {}),
                  })}>
                    <SelectTrigger id="inc-responsable" className="mt-1 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(RESPONSABLES) as Responsable[]).map(r => <SelectItem key={r} value={r}>{RESPONSABLES[r]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="inc-compensacion">Compensación al cliente ($)</Label>
                  <Input id="inc-compensacion" inputMode="decimal" value={decision.compensacion}
                    disabled={resolviendo?.estado === 'compensada'}
                    onChange={e => setDecision({ ...decision, compensacion: e.target.value })} />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {resolviendo?.estado === 'compensada'
                      ? 'El saldo ya se le dio al instante: aquí solo confirmas quién responde.'
                      : <>Sugerido por la base: {dinero(resolviendo?.sugeridoCents)}. Se le da como saldo Umbani al resolver. Nunca más que el total del pedido.</>}
                  </p>
                </div>
              </>
            )}
            <div>
              <Label htmlFor="inc-nota">Qué pasó (queda anotado)</Label>
              <Textarea id="inc-nota" rows={3} value={decision.nota} onChange={e => setDecision({ ...decision, nota: e.target.value })} />
            </div>
          </div>
          <Button disabled={resolver.isPending || decision.nota.trim().length < 3} onClick={() => resolver.mutate()}>
            {decision.estado === 'descartada' ? 'Descartar' : resolviendo?.estado === 'compensada' ? 'Confirmar' : 'Resolver'}
          </Button>
        </DialogContent>
      </Dialog>

      <Dialog open={registrando} onOpenChange={setRegistrando}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar una incidencia</DialogTitle>
            <DialogDescription>Las que el cliente no ve: se cayó la comida, el cliente no estaba, un accidente…</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div>
              <Label htmlFor="reg-local">Local</Label>
              <Select value={nueva.localId || 'ninguno'} onValueChange={v => setNueva({ ...nueva, localId: v === 'ninguno' ? '' : v })}>
                <SelectTrigger id="reg-local" className="mt-1 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ninguno">Elige el local</SelectItem>
                  {(locales.data || []).map(l => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="reg-numero">Número del pedido</Label>
              <Input id="reg-numero" inputMode="numeric" value={nueva.numero} placeholder="41" onChange={e => setNueva({ ...nueva, numero: e.target.value.replace(/\D/g, '') })} />
            </div>
            <div>
              <Label htmlFor="reg-tipo">Qué pasó</Label>
              <Select value={nueva.tipo} onValueChange={v => setNueva({ ...nueva, tipo: v as TipoDeIncidencia })}>
                <SelectTrigger id="reg-tipo" className="mt-1 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(TIPOS) as TipoDeIncidencia[]).map(t => <SelectItem key={t} value={t}>{TIPOS[t]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="reg-nota">Detalle</Label>
              <Textarea id="reg-nota" rows={3} value={nueva.nota} onChange={e => setNueva({ ...nueva, nota: e.target.value })} />
            </div>
          </div>
          <Button disabled={registrar.isPending || !nueva.localId || !nueva.numero || nueva.nota.trim().length < 3} onClick={() => registrar.mutate()}>
            Registrar
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
