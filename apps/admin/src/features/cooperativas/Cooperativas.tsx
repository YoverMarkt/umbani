import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Badge } from '@botpanel/ui/components/badge'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@botpanel/ui/components/dialog'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { getCiudades } from '../ciudades/api'
import { activarCooperativa, crearAcceso, crearCooperativa, darClaveNueva, getCooperativas, type Cooperativa } from './api'

// ═══════════════════════════════════════════════════════════════════════════
// COOPERATIVAS — la tercera flota (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Como los «socios de flota» de las grandes: la cooperativa registra a SUS
// motorizados en su panel (`/cooperativa`), ve sus carreras y responde por
// ellos. Aquí el superadmin la da de alta con su ciudad y su primer acceso,
// la apaga o la enciende y da claves nuevas. Para que reparta en un local, en
// la ficha del local: «Quién reparte → Una cooperativa».
// ⚠️ No se borran: apagarla le corta el panel y sus motorizados no toman nada
// nuevo, sin perder su historia ni su dinero.

const MINIMO_CLAVE = 12
const VACIA = { nombre: '', ciudadId: '', telefono: '', email: '', clave: '', persona: '' }

export default function Cooperativas() {
  const qc = useQueryClient()
  const consulta = useQuery({ queryKey: ['cooperativas'], queryFn: getCooperativas })
  const ciudades = useQuery({ queryKey: ['ciudades'], queryFn: getCiudades })
  const refrescar = () => qc.invalidateQueries({ queryKey: ['cooperativas'] })
  const [nueva, setNueva] = useState(VACIA)

  const crear = useMutation({
    mutationFn: () => crearCooperativa({
      nombre: nueva.nombre.trim(),
      ciudadId: nueva.ciudadId,
      telefono: nueva.telefono.trim(),
      usuario: { email: nueva.email.trim(), clave: nueva.clave, nombre: nueva.persona.trim() },
    }),
    onSuccess: () => {
      toast.success('Cooperativa creada. Dale su correo y su contraseña: con eso entra a su panel.')
      setNueva(VACIA)
      refrescar()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const cambiar = useMutation({
    mutationFn: (c: Cooperativa) => activarCooperativa(c.id, !c.activa),
    onSuccess: refrescar,
    onError: (e: Error) => toast.error(e.message),
  })

  // Otro acceso, o una clave nueva para quien la olvidó.
  const [acceso, setAcceso] = useState<Cooperativa | null>(null)
  const [datosAcceso, setDatosAcceso] = useState({ email: '', clave: '', nombre: '' })
  const agregar = useMutation({
    mutationFn: () => crearAcceso(acceso!.id, { email: datosAcceso.email.trim(), clave: datosAcceso.clave, nombre: datosAcceso.nombre.trim() }),
    onSuccess: () => { toast.success('Acceso creado'); setAcceso(null); refrescar() },
    onError: (e: Error) => toast.error(e.message),
  })
  const [claveDe, setClaveDe] = useState<{ id: string; email: string } | null>(null)
  const [clave, setClave] = useState('')
  const cambiarClave = useMutation({
    mutationFn: () => darClaveNueva(claveDe!.id, clave),
    onSuccess: () => { toast.success('Clave cambiada. Dásela en persona, nunca por un grupo.'); setClaveDe(null); setClave('') },
    onError: (e: Error) => toast.error(e.message),
  })

  if (consulta.isError) return <QueryError onRetry={() => consulta.refetch()} />
  if (consulta.isLoading || !consulta.data) return <Skeleton className="h-64 w-full" />

  const activas = (ciudades.data || []).filter(c => c.active)
  const lista = nueva.nombre.trim().length >= 2 && nueva.ciudadId && nueva.email.includes('@') && nueva.clave.length >= MINIMO_CLAVE
  const panel = `${window.location.origin}/cooperativa`

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Cooperativas</h1>
        <p className="text-sm text-muted-foreground">
          Cooperativas de reparto: registran a sus motorizados en su panel
          (<a className="underline underline-offset-2" href={panel} target="_blank" rel="noreferrer">{panel}</a>),
          ven sus carreras semana a semana y las descargan para calcular su comisión. Umbani le paga la carrera a
          cada motorizado el lunes y él liquida su efectivo con Umbani, como uno de Umbani. Para que reparta en un
          local: en su ficha, «Quién reparte → Una cooperativa».
        </p>
      </div>

      <Card className="p-4">
        <h2 className="mb-3 text-base font-semibold text-foreground">Nueva cooperativa</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="coop-nombre">Nombre</Label>
            <Input id="coop-nombre" value={nueva.nombre} placeholder="Cooperativa de Motos Chone"
              onChange={e => setNueva({ ...nueva, nombre: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="coop-ciudad">Ciudad donde reparte</Label>
            <Select value={nueva.ciudadId || 'ninguna'} onValueChange={v => setNueva({ ...nueva, ciudadId: v === 'ninguna' ? '' : v })}>
              <SelectTrigger id="coop-ciudad" className="mt-1 w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ninguna">Elige la ciudad</SelectItem>
                {activas.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="coop-telefono">Teléfono de contacto (opcional)</Label>
            <Input id="coop-telefono" inputMode="tel" value={nueva.telefono} placeholder="0991234567"
              onChange={e => setNueva({ ...nueva, telefono: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="coop-persona">Quién la maneja (opcional)</Label>
            <Input id="coop-persona" value={nueva.persona} placeholder="Rosa Zambrano"
              onChange={e => setNueva({ ...nueva, persona: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="coop-email">Correo para entrar a su panel</Label>
            <Input id="coop-email" type="email" value={nueva.email} placeholder="cooperativa@correo.com"
              onChange={e => setNueva({ ...nueva, email: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="coop-clave">Contraseña</Label>
            <Input id="coop-clave" type="password" autoComplete="new-password" value={nueva.clave}
              onChange={e => setNueva({ ...nueva, clave: e.target.value })} />
            <p className="mt-1 text-xs text-muted-foreground">Mínimo {MINIMO_CLAVE} caracteres. Dásela en persona.</p>
          </div>
        </div>
        <Button className="mt-3" disabled={crear.isPending || !lista} onClick={() => crear.mutate()}>
          Crear cooperativa
        </Button>
      </Card>

      <Card className="p-0">
        {!consulta.data.length
          ? <p className="p-4 text-sm text-muted-foreground">Todavía no hay cooperativas.</p>
          : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cooperativa</TableHead>
                  <TableHead>Motorizados</TableHead>
                  <TableHead>Acceso a su panel</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right">Acción</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {consulta.data.map(c => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <div className="font-medium">{c.nombre}</div>
                      <div className="text-xs text-muted-foreground">{c.ciudad}{c.telefono ? ` · ${c.telefono}` : ''}</div>
                    </TableCell>
                    <TableCell className="tabular-nums">{c.repartidores}</TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        {c.usuarios.map(u => (
                          <div key={u.id} className="flex items-center gap-2 text-sm">
                            <span>{u.email}</span>
                            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => { setClaveDe({ id: u.id, email: u.email }); setClave('') }}>
                              Clave nueva
                            </Button>
                          </div>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={c.activa ? 'default' : 'outline'}>{c.activa ? 'Repartiendo' : 'Apagada'}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => { setAcceso(c); setDatosAcceso({ email: '', clave: '', nombre: '' }) }}>
                          Otro acceso
                        </Button>
                        {c.activa
                          ? (
                            <ConfirmAction
                              trigger={<Button size="sm" variant="outline" disabled={cambiar.isPending}>Apagar</Button>}
                              title={`¿Apagar ${c.nombre}?`}
                              description="Se le cierra su panel y sus motorizados dejan de recibir pedidos nuevos (lo que ya llevan, lo terminan). No se borra nada: la puedes volver a encender."
                              confirmLabel="Apagar"
                              destructive
                              onConfirm={() => cambiar.mutate(c)}
                            />
                          )
                          : <Button size="sm" variant="outline" disabled={cambiar.isPending} onClick={() => cambiar.mutate(c)}>Encender</Button>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </Card>

      <Dialog open={Boolean(acceso)} onOpenChange={abierto => { if (!abierto) setAcceso(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Otro acceso a {acceso?.nombre}</DialogTitle>
            <DialogDescription>Otra persona de la cooperativa, con su propio correo y contraseña.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div>
              <Label htmlFor="acceso-email">Correo</Label>
              <Input id="acceso-email" type="email" value={datosAcceso.email} onChange={e => setDatosAcceso({ ...datosAcceso, email: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="acceso-nombre">Nombre (opcional)</Label>
              <Input id="acceso-nombre" value={datosAcceso.nombre} onChange={e => setDatosAcceso({ ...datosAcceso, nombre: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="acceso-clave">Contraseña (mínimo {MINIMO_CLAVE})</Label>
              <Input id="acceso-clave" type="password" autoComplete="new-password" value={datosAcceso.clave} onChange={e => setDatosAcceso({ ...datosAcceso, clave: e.target.value })} />
            </div>
          </div>
          <Button disabled={agregar.isPending || !datosAcceso.email.includes('@') || datosAcceso.clave.length < MINIMO_CLAVE} onClick={() => agregar.mutate()}>
            Crear acceso
          </Button>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(claveDe)} onOpenChange={abierto => { if (!abierto) setClaveDe(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clave nueva</DialogTitle>
            <DialogDescription>Para {claveDe?.email}. La anterior deja de servir para entrar.</DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="clave-nueva">Contraseña (mínimo {MINIMO_CLAVE})</Label>
            <Input id="clave-nueva" type="password" autoComplete="new-password" value={clave} onChange={e => setClave(e.target.value)} />
          </div>
          <Button disabled={cambiarClave.isPending || clave.length < MINIMO_CLAVE} onClick={() => cambiarClave.mutate()}>
            Guardar clave nueva
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
