import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Badge } from '@botpanel/ui/components/badge'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { activarCiudad, crearCiudad, getCiudades, type Ciudad } from './api'

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
  const [nueva, setNueva] = useState({ nombre: '', provincia: 'Manabí' })
  const refrescar = () => qc.invalidateQueries({ queryKey: ['ciudades'] })

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
                  <Badge variant={c.active ? 'default' : 'outline'}>{c.active ? 'Atendiendo' : 'Apagada'}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" disabled={cambiar.isPending} onClick={() => cambiar.mutate(c)}>
                    {c.active ? 'Apagar' : 'Encender'}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
