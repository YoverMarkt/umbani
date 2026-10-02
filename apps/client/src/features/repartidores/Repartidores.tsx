import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Badge } from '@botpanel/ui/components/badge'
import { Button } from '@botpanel/ui/components/button'
import { Card, CardContent, CardHeader, CardTitle } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { api } from '../../api/client'

// ═══════════════════════════════════════════════════════════════════════════
// REPARTIDORES — LA FLOTA PROPIA DEL LOCAL (2026-10-02)
// ═══════════════════════════════════════════════════════════════════════════
//
// El local registra a SUS repartidores: entran a la app del motorizado con su
// WhatsApp y solo ven los pedidos de este local. La carrera es del local, y
// aquí se ve cuánto efectivo lleva cada uno, que es lo que se le pide al
// cerrar el turno.
//
// ⚠️ Solo aparece cuando el superadmin enciende «Repartidores propios» y solo
// para el dueño. Aquí NO se calcula nada: el efectivo llega en centavos.

type Repartidor = {
  id: string
  nombre: string
  telefono: string
  vehiculo: string | null
  activo: boolean
  disponible: boolean
  efectivoEnCursoCents: number
  cobradoHoyCents: number
  entregasHoy: number
}

const dinero = (c: number) => `$${(c / 100).toFixed(2)}`

export default function Repartidores() {
  const qc = useQueryClient()
  const consulta = useQuery({
    queryKey: ['repartidores'],
    queryFn: () => api<{ repartidores: Repartidor[] }>('/api/client/repartidores'),
    // El efectivo cambia con cada entrega: se refresca solo.
    refetchInterval: 60_000,
  })
  const [nuevo, setNuevo] = useState({ nombre: '', telefono: '', vehiculo: '' })
  const refrescar = () => qc.invalidateQueries({ queryKey: ['repartidores'] })

  const registrar = useMutation({
    mutationFn: () => api('/api/client/repartidores', { method: 'POST', body: JSON.stringify(nuevo) }),
    onSuccess: () => {
      toast.success('Repartidor registrado. Ya puede entrar a la app con su WhatsApp.')
      setNuevo({ nombre: '', telefono: '', vehiculo: '' })
      refrescar()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const cambiar = useMutation({
    mutationFn: (r: Repartidor) => api(`/api/client/repartidores/${r.id}/activo`, {
      method: 'PUT', body: JSON.stringify({ activo: !r.activo }),
    }),
    onSuccess: refrescar,
    onError: (e: Error) => toast.error(e.message),
  })

  if (consulta.isError) return <QueryError onRetry={() => consulta.refetch()} />
  if (consulta.isLoading || !consulta.data) return <Skeleton className="h-64 w-full" />
  const { repartidores } = consulta.data

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Repartidores</h1>
        <p className="text-sm text-muted-foreground">
          Tus repartidores entran a la app de Umbani con su WhatsApp y solo ven los pedidos de tu local.
          El envío es tuyo; aquí ves cuánto efectivo lleva cada uno.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Registrar un repartidor</CardTitle></CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="rep-nombre">Nombre</Label>
              <Input id="rep-nombre" value={nuevo.nombre} onChange={e => setNuevo({ ...nuevo, nombre: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="rep-tel">WhatsApp</Label>
              <Input id="rep-tel" inputMode="tel" placeholder="593991234567" value={nuevo.telefono}
                onChange={e => setNuevo({ ...nuevo, telefono: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="rep-veh">Vehículo (opcional)</Label>
              <Input id="rep-veh" placeholder="Moto ABC-123" value={nuevo.vehiculo}
                onChange={e => setNuevo({ ...nuevo, vehiculo: e.target.value })} />
            </div>
          </div>
          <Button className="mt-3"
            disabled={registrar.isPending || nuevo.nombre.trim().length < 2 || nuevo.telefono.replace(/\D/g, '').length < 8}
            onClick={() => registrar.mutate()}>
            Registrar
          </Button>
        </CardContent>
      </Card>

      <Card className="p-0">
        {repartidores.length === 0
          ? <p className="p-6 text-sm text-muted-foreground">Todavía no registraste repartidores.</p>
          : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repartidor</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Por cobrar ahora</TableHead>
                  <TableHead className="text-right">Cobrado hoy</TableHead>
                  <TableHead className="text-right">Acción</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {repartidores.map(r => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="font-medium">{r.nombre}</div>
                      <div className="text-xs text-muted-foreground">{r.telefono}{r.vehiculo ? ` · ${r.vehiculo}` : ''}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{!r.activo ? 'Inactivo' : r.disponible ? 'Disponible' : 'No disponible'}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{dinero(r.efectivoEnCursoCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {dinero(r.cobradoHoyCents)}
                      <div className="text-xs text-muted-foreground">{r.entregasHoy} entrega{r.entregasHoy === 1 ? '' : 's'}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" disabled={cambiar.isPending} onClick={() => cambiar.mutate(r)}>
                        {r.activo ? 'Desactivar' : 'Activar'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </Card>
    </div>
  )
}
