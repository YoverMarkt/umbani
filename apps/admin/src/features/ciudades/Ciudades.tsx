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
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { activarCiudad, crearCiudad, getCiudades, getSinCobertura, guardarArea, type Ciudad } from './api'

const enElMapa = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`

// ═══════════════════════════════════════════════════════════════════════════
// CIUDADES — dónde atiende Umbani (2026-10-05)
// ═══════════════════════════════════════════════════════════════════════════
//
// Como las grandes, el cliente dice dónde está antes de ver nada. Un local sin
// ciudad no aparece a ningún cliente (por eso desaparecieron los de muestra),
// y el motorizado de Umbani solo ve los pedidos de la suya.
// ⚠️ No se borran: apagar una ciudad la quita del chat y de la app sin perder
// a qué ciudad pertenece cada local y cada cliente.

export default function Ciudades() {
  const qc = useQueryClient()
  const consulta = useQuery({ queryKey: ['ciudades'], queryFn: getCiudades })
  // Quién abre la app fuera de toda ciudad: dónde abrir la siguiente.
  const fuera = useQuery({ queryKey: ['ciudades-sin-cobertura'], queryFn: () => getSinCobertura(30) })
  const [nueva, setNueva] = useState({ nombre: '', provincia: 'Manabí' })
  const refrescar = () => qc.invalidateQueries({ queryKey: ['ciudades'] })

  // El centro y el radio de una ciudad (2026-10-05): de ahí sale la ciudad del
  // cliente por su GPS, y la entrega tiene que caer dentro.
  const [editando, setEditando] = useState<Ciudad | null>(null)
  const [area, setArea] = useState({ latitud: '', longitud: '', radioKm: '6' })
  const abrirArea = (c: Ciudad) => {
    setEditando(c)
    setArea({ latitud: c.latitude?.toString() ?? '', longitud: c.longitude?.toString() ?? '', radioKm: String(c.radius_km ?? 6) })
  }
  const guardar = useMutation({
    mutationFn: () => guardarArea(editando!.id, {
      latitud: Number(area.latitud), longitud: Number(area.longitud), radioKm: Number(area.radioKm),
    }),
    onSuccess: () => { toast.success('Cobertura guardada'); setEditando(null); refrescar() },
    onError: (e: Error) => toast.error(e.message),
  })

  const crear = useMutation({
    mutationFn: () => crearCiudad(nueva.nombre.trim(), nueva.provincia.trim()),
    onSuccess: () => {
      toast.success('Ciudad creada. Asígnala a sus locales en la ficha de cada uno.')
      setNueva({ ...nueva, nombre: '' })
      refrescar()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const cambiar = useMutation({
    mutationFn: (c: Ciudad) => activarCiudad(c.id, !c.active),
    onSuccess: refrescar,
    onError: (e: Error) => toast.error(e.message),
  })

  if (consulta.isError) return <QueryError onRetry={() => consulta.refetch()} />
  if (consulta.isLoading || !consulta.data) return <Skeleton className="h-64 w-full" />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Ciudades</h1>
        <p className="text-sm text-muted-foreground">
          Dónde atiende Umbani. El chat le pregunta al cliente su ciudad cuando hay más de una con locales,
          y solo le enseña los de la suya. Un local sin ciudad no aparece a ningún cliente.
        </p>
      </div>

      <Card className="p-4">
        <h2 className="mb-3 text-base font-semibold text-foreground">Nueva ciudad</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ciudad-nombre">Nombre</Label>
            <Input id="ciudad-nombre" value={nueva.nombre} placeholder="Chone"
              onChange={e => setNueva({ ...nueva, nombre: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="ciudad-provincia">Provincia</Label>
            <Input id="ciudad-provincia" value={nueva.provincia}
              onChange={e => setNueva({ ...nueva, provincia: e.target.value })} />
          </div>
        </div>
        <Button className="mt-3" disabled={crear.isPending || nueva.nombre.trim().length < 2} onClick={() => crear.mutate()}>
          Crear ciudad
        </Button>
      </Card>

      <Card className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Ciudad</TableHead>
              <TableHead>Cobertura</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Acción</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {consulta.data.map(c => (
              <TableRow key={c.id}>
                <TableCell>
                  <div className="font-medium">{c.name}</div>
                  {c.province && <div className="text-xs text-muted-foreground">{c.province}</div>}
                </TableCell>
                <TableCell>
                  {c.latitude != null && c.longitude != null
                    ? (
                      <a className="text-sm underline underline-offset-2" href={enElMapa(c.latitude, c.longitude)} target="_blank" rel="noreferrer">
                        {c.radius_km} km desde el centro
                      </a>
                    )
                    : <span className="text-xs text-amber-700 dark:text-amber-400">Sin centro: la app no la encuentra por GPS</span>}
                </TableCell>
                <TableCell>
                  <Badge variant={c.active ? 'default' : 'outline'}>{c.active ? 'Atendiendo' : 'Apagada'}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => abrirArea(c)}>Cobertura</Button>
                    <Button size="sm" variant="outline" disabled={cambiar.isPending} onClick={() => cambiar.mutate(c)}>
                      {c.active ? 'Apagar' : 'Encender'}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Card className="p-4">
        <h2 className="mb-1 text-base font-semibold text-foreground">Quién pide desde fuera (últimos 30 días)</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Personas que abrieron la app fuera de toda ciudad. El punto está redondeado a ~1 km: dice dónde hay
          demanda, no la casa de nadie. Es el dato para decidir la próxima ciudad.
        </p>
        {!fuera.data?.length
          ? <p className="text-sm text-muted-foreground">Todavía nadie la abrió fuera de cobertura.</p>
          : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Dónde</TableHead>
                  <TableHead>Ciudad más cercana</TableHead>
                  <TableHead className="text-right">Personas</TableHead>
                  <TableHead className="text-right">Última vez</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fuera.data.map(p => (
                  <TableRow key={`${p.lat_aprox},${p.lng_aprox}`}>
                    <TableCell>
                      <a className="underline underline-offset-2" href={enElMapa(p.lat_aprox, p.lng_aprox)} target="_blank" rel="noreferrer">Ver en el mapa</a>
                    </TableCell>
                    <TableCell>{p.ciudad_cercana ? `${p.ciudad_cercana} · ${p.km} km` : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.personas}</TableCell>
                    <TableCell className="text-right">{p.ultima}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </Card>

      <Dialog open={Boolean(editando)} onOpenChange={abierto => { if (!abierto) setEditando(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cobertura de {editando?.name}</DialogTitle>
            <DialogDescription>
              El centro de la ciudad y hasta dónde se reparte. Quien abre la app dentro de este radio ve sus
              locales, y la dirección de entrega tiene que caer dentro. Copia el centro desde Google Maps
              (clic derecho en el mapa → las coordenadas).
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="area-lat">Latitud</Label>
              <Input id="area-lat" inputMode="decimal" value={area.latitud} placeholder="-0.69819" onChange={e => setArea({ ...area, latitud: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="area-lng">Longitud</Label>
              <Input id="area-lng" inputMode="decimal" value={area.longitud} placeholder="-80.09361" onChange={e => setArea({ ...area, longitud: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="area-radio">Radio (km)</Label>
              <Input id="area-radio" inputMode="decimal" value={area.radioKm} onChange={e => setArea({ ...area, radioKm: e.target.value })} />
            </div>
          </div>
          {area.latitud && area.longitud && (
            <a className="text-sm underline underline-offset-2" href={enElMapa(Number(area.latitud), Number(area.longitud))} target="_blank" rel="noreferrer">
              Comprobar el centro en el mapa
            </a>
          )}
          <Button disabled={guardar.isPending || !area.latitud || !area.longitud} onClick={() => guardar.mutate()}>
            Guardar cobertura
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  )
}
