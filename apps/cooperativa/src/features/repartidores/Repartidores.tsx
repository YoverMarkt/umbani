import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@botpanel/ui/components/badge'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@botpanel/ui/components/dialog'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { dolares } from '../../api/client'
import { Dato, Ficha, Fichas, SoloEnPantallaAncha } from '../../components/Fichas'
import { activarRepartidor, crearRepartidor, getRepartidores, type NuevoRepartidor, type Repartidor } from './api'

// Los motorizados de la cooperativa: los registra ella. Entran a la app de
// Umbani con su CORREO (2026-10-06) y solo ven los pedidos de los locales que reparte
// esta cooperativa, en su ciudad (lo decide el servidor).

const VACIO: NuevoRepartidor = { nombre: '', telefono: '', correo: '', vehiculo: 'Moto', cedula: '', placa: '', licencia: '' }

function estadoDe(r: Repartidor) {
  if (!r.activo) return { texto: 'Apagado', variante: 'outline' as const }
  return r.disponible ? { texto: 'Disponible', variante: 'default' as const } : { texto: 'No disponible', variante: 'secondary' as const }
}

export default function Repartidores() {
  const qc = useQueryClient()
  const consulta = useQuery({ queryKey: ['repartidores'], queryFn: getRepartidores })
  const refrescar = () => qc.invalidateQueries({ queryKey: ['repartidores'] })
  const [abierto, setAbierto] = useState(false)
  const [nuevo, setNuevo] = useState(VACIO)

  const crear = useMutation({
    mutationFn: () => crearRepartidor(nuevo),
    onSuccess: () => {
      toast.success('Repartidor registrado. Ya puede entrar a la app de Umbani con su correo.')
      setNuevo(VACIO)
      setAbierto(false)
      refrescar()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const cambiar = useMutation({
    mutationFn: (r: Repartidor) => activarRepartidor(r.id, !r.activo),
    onSuccess: refrescar,
    onError: (e: Error) => toast.error(e.message),
  })

  const campo = (clave: keyof NuevoRepartidor) => ({
    value: nuevo[clave],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setNuevo({ ...nuevo, [clave]: e.target.value }),
  })
  const listo = nuevo.nombre.trim().length >= 2 && nuevo.telefono.replace(/\D/g, '').length >= 9 && nuevo.correo.includes('@')
    && nuevo.cedula.trim().length >= 5 && nuevo.placa.trim().length >= 3 && nuevo.vehiculo.trim().length >= 2

  /** Apagar pide confirmación: le cierra la app. Encender, no. */
  const accion = (r: Repartidor) => (r.activo
    ? (
      <ConfirmAction
        trigger={<Button size="sm" variant="outline" disabled={cambiar.isPending}>Apagar</Button>}
        title={`¿Apagar a ${r.nombre}?`}
        description="Ya no podrá entrar a la app ni recibir pedidos. Si lleva un pedido ahora, espera a que lo entregue antes de apagarlo. Lo puedes volver a encender."
        confirmLabel="Apagar"
        destructive
        onConfirm={() => cambiar.mutate(r)}
      />
    )
    : <Button size="sm" variant="outline" disabled={cambiar.isPending} onClick={() => cambiar.mutate(r)}>Encender</Button>)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold text-foreground">Repartidores</h1>
          <p className="text-sm text-muted-foreground">
            Entran a la app de Umbani con su correo y solo ven los pedidos de los locales que reparte tu
            cooperativa.
          </p>
        </div>
        <Button onClick={() => setAbierto(true)}><Plus className="size-4" /> Nuevo repartidor</Button>
      </div>

      {consulta.isError
        ? <QueryError onRetry={() => consulta.refetch()} />
        : !consulta.data
          ? <Skeleton className="h-48 w-full" />
          : (
            <Card className="p-0">
              {!consulta.data.length
                ? <p className="p-4 text-sm text-muted-foreground">Todavía no registraste a ningún repartidor.</p>
                : (
                  <>
                    <Fichas>
                      {consulta.data.map(r => {
                        const estado = estadoDe(r)
                        return (
                          <Ficha key={r.id} titulo={r.nombre} detalle={`${r.telefono}${r.cedula ? ` · ${r.cedula}` : ''}`}
                            derecha={<Badge variant={estado.variante}>{estado.texto}</Badge>}>
                            <Dato nombre="Vehículo" valor={[r.vehiculo, r.placa].filter(Boolean).join(' · ') || '—'} />
                            <Dato nombre="Efectivo encima" valor={`${dolares(r.efectivoEncimaCents)} de ${dolares(r.topeEfectivoCents)}`} />
                            <div className="pt-1">{accion(r)}</div>
                          </Ficha>
                        )
                      })}
                    </Fichas>
                    <SoloEnPantallaAncha>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Repartidor</TableHead>
                            <TableHead>Vehículo</TableHead>
                            <TableHead className="text-right">Efectivo encima</TableHead>
                            <TableHead>Estado</TableHead>
                            <TableHead className="text-right">Acción</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {consulta.data.map(r => {
                            const estado = estadoDe(r)
                            return (
                              <TableRow key={r.id}>
                                <TableCell>
                                  <div className="font-medium">{r.nombre}</div>
                                  <div className="text-xs text-muted-foreground">{r.telefono}{r.cedula ? ` · ${r.cedula}` : ''}</div>
                                </TableCell>
                                <TableCell>{[r.vehiculo, r.placa].filter(Boolean).join(' · ')}</TableCell>
                                <TableCell className="text-right tabular-nums">
                                  {dolares(r.efectivoEncimaCents)} <span className="text-xs text-muted-foreground">de {dolares(r.topeEfectivoCents)}</span>
                                </TableCell>
                                <TableCell><Badge variant={estado.variante}>{estado.texto}</Badge></TableCell>
                                <TableCell className="text-right">{accion(r)}</TableCell>
                              </TableRow>
                            )
                          })}
                        </TableBody>
                      </Table>
                    </SoloEnPantallaAncha>
                  </>
                )}
            </Card>
          )}

      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nuevo repartidor</DialogTitle>
            <DialogDescription>
              Con su correo entra a la app de Umbani; su WhatsApp es para llamarlo. La cédula y la placa quedan registradas por si hay un problema.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="rep-nombre">Nombre</Label>
              <Input id="rep-nombre" placeholder="Andrés Mera" {...campo('nombre')} />
            </div>
            <div>
              <Label htmlFor="rep-telefono">WhatsApp</Label>
              <Input id="rep-telefono" inputMode="tel" placeholder="0991234567" {...campo('telefono')} />
            </div>
            <div>
              <Label htmlFor="rep-correo">Correo (con él entra a la app)</Label>
              <Input id="rep-correo" type="email" inputMode="email" autoCapitalize="none" placeholder="andres@correo.com" {...campo('correo')} />
            </div>
            <div>
              <Label htmlFor="rep-cedula">Cédula o pasaporte</Label>
              <Input id="rep-cedula" placeholder="1312345678" {...campo('cedula')} />
            </div>
            <div>
              <Label htmlFor="rep-vehiculo">Vehículo</Label>
              <Input id="rep-vehiculo" placeholder="Moto" {...campo('vehiculo')} />
            </div>
            <div>
              <Label htmlFor="rep-placa">Placa</Label>
              <Input id="rep-placa" placeholder="MB123A" {...campo('placa')} />
            </div>
            <div>
              <Label htmlFor="rep-licencia">Licencia (opcional)</Label>
              <Input id="rep-licencia" {...campo('licencia')} />
            </div>
          </div>
          <Button disabled={crear.isPending || !listo} onClick={() => crear.mutate()}>
            {crear.isPending ? 'Registrando…' : 'Registrar repartidor'}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
