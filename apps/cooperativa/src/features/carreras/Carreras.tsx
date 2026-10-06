import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@botpanel/ui/components/badge'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Label } from '@botpanel/ui/components/label'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { descargar, dolares } from '../../api/client'
import { Dato, Ficha, Fichas, SoloEnPantallaAncha } from '../../components/Fichas'
import { getCarreras, getSemana } from './api'

// Las carreras de sus motorizados, semana a semana. La cooperativa las
// descarga para calcular SU comisión, que queda entre ella y cada motorizado.
// ⚠️ Aquí no se suma nada: cada cifra viene del servidor, en centavos.

const EN_CURSO = 'en-curso'

/** «28 sept – 4 oct». */
const dia = (fecha: string) => new Date(`${fecha}T12:00:00`).toLocaleDateString('es-EC', { day: 'numeric', month: 'short' })
const semanaDesde = (lunes: string) => {
  const domingo = new Date(`${lunes}T12:00:00`)
  domingo.setDate(domingo.getDate() + 6)
  return `${dia(lunes)} – ${domingo.toLocaleDateString('es-EC', { day: 'numeric', month: 'short' })}`
}

const ESTADO: Record<string, string> = {
  por_pagar: 'Umbani le paga', pagada: 'Pagada', por_cobrar: 'Debe entregarlo', cobrada: 'Entregado',
  en_cero: 'En cero', compensada: 'Pasó a la semana siguiente',
}

/** Quién le debe a quién, dicho con palabras. */
const saldo = (centavos: number) => (
  centavos > 0 ? `Umbani le paga ${dolares(centavos)}` : centavos < 0 ? `Entrega ${dolares(centavos)}` : 'En cero'
)

export default function Carreras() {
  const [semana, setSemana] = useState(EN_CURSO)
  const resumen = useQuery({ queryKey: ['carreras'], queryFn: getCarreras })
  const cerrada = useQuery({ queryKey: ['carreras', semana], queryFn: () => getSemana(semana), enabled: semana !== EN_CURSO })
  const [bajando, setBajando] = useState(false)

  const bajar = async () => {
    setBajando(true)
    try {
      await descargar(`/api/cooperativa/carreras.csv?semana=${semana}`, semana === EN_CURSO ? 'carreras-semana-en-curso.csv' : `carreras-${semana}.csv`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo descargar')
    } finally {
      setBajando(false)
    }
  }

  if (resumen.isError) return <QueryError onRetry={() => resumen.refetch()} />
  if (!resumen.data) return <Skeleton className="h-64 w-full" />

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Carreras</h1>
        <p className="text-sm text-muted-foreground">
          Cada lunes Umbani cierra la semana de cada repartidor: le paga sus carreras y le cobra el efectivo que
          tiene. Descárgalas para calcular tu comisión.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56">
          <Label htmlFor="semana">Semana</Label>
          <Select value={semana} onValueChange={setSemana}>
            <SelectTrigger id="semana" className="mt-1 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={EN_CURSO}>Semana en curso</SelectItem>
              {resumen.data.semanas.map(s => <SelectItem key={s} value={s}>{semanaDesde(s)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" disabled={bajando} onClick={() => void bajar()}>
          <Download className="size-4" /> {bajando ? 'Descargando…' : 'Descargar para Excel'}
        </Button>
      </div>

      <Card className="p-0">
        {semana === EN_CURSO
          ? (!resumen.data.enCurso.length
            ? <p className="p-4 text-sm text-muted-foreground">Todavía no tienes repartidores.</p>
            : (
              <>
                <Fichas>
                  {resumen.data.enCurso.map(f => (
                    <Ficha key={f.id} titulo={f.nombre} detalle={f.telefono} derecha={<span className="text-sm tabular-nums">{f.pedidos} pedidos</span>}>
                      <Dato nombre="Carreras" valor={dolares(f.carrerasCents)} />
                      {f.retenidasCents > 0 && <Dato nombre="Retenidas" valor={dolares(f.retenidasCents)} />}
                      <Dato nombre="Efectivo cobrado" valor={dolares(f.efectivoCobradoCents)} />
                      <Dato nombre="Efectivo encima" valor={dolares(f.efectivoEncimaCents)} />
                    </Ficha>
                  ))}
                </Fichas>
                <SoloEnPantallaAncha>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Repartidor</TableHead>
                        <TableHead className="text-right">Pedidos</TableHead>
                        <TableHead className="text-right">Carreras</TableHead>
                        <TableHead className="text-right">Retenidas</TableHead>
                        <TableHead className="text-right">Efectivo cobrado</TableHead>
                        <TableHead className="text-right">Efectivo encima</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {resumen.data.enCurso.map(f => (
                        <TableRow key={f.id}>
                          <TableCell><div className="font-medium">{f.nombre}</div><div className="text-xs text-muted-foreground">{f.telefono}</div></TableCell>
                          <TableCell className="text-right tabular-nums">{f.pedidos}</TableCell>
                          <TableCell className="text-right tabular-nums">{dolares(f.carrerasCents)}</TableCell>
                          <TableCell className="text-right tabular-nums">{f.retenidasCents ? dolares(f.retenidasCents) : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{dolares(f.efectivoCobradoCents)}</TableCell>
                          <TableCell className="text-right tabular-nums">{dolares(f.efectivoEncimaCents)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </SoloEnPantallaAncha>
              </>
            ))
          : cerrada.isError
            ? <QueryError onRetry={() => cerrada.refetch()} />
            : !cerrada.data
              ? <Skeleton className="h-40 w-full" />
              : !cerrada.data.length
                ? <p className="p-4 text-sm text-muted-foreground">Ningún repartidor tuvo carreras esa semana.</p>
                : (
                  <>
                    <Fichas>
                      {cerrada.data.map(f => (
                        <Ficha key={f.id} titulo={f.nombre} detalle={f.telefono}
                          derecha={<Badge variant="outline">{ESTADO[f.estado] ?? f.estado}</Badge>}>
                          <Dato nombre="Pedidos" valor={f.pedidos} />
                          <Dato nombre="Carreras" valor={dolares(f.carrerasCents)} />
                          <Dato nombre="Efectivo cobrado" valor={dolares(f.efectivoCobradoCents)} />
                          <Dato nombre="Saldo con Umbani" valor={saldo(f.saldoCents)} />
                        </Ficha>
                      ))}
                    </Fichas>
                    <SoloEnPantallaAncha>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Repartidor</TableHead>
                            <TableHead className="text-right">Pedidos</TableHead>
                            <TableHead className="text-right">Carreras</TableHead>
                            <TableHead className="text-right">Efectivo cobrado</TableHead>
                            <TableHead className="text-right">Saldo con Umbani</TableHead>
                            <TableHead>Estado</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {cerrada.data.map(f => (
                            <TableRow key={f.id}>
                              <TableCell><div className="font-medium">{f.nombre}</div><div className="text-xs text-muted-foreground">{f.telefono}</div></TableCell>
                              <TableCell className="text-right tabular-nums">{f.pedidos}</TableCell>
                              <TableCell className="text-right tabular-nums">{dolares(f.carrerasCents)}</TableCell>
                              <TableCell className="text-right tabular-nums">{dolares(f.efectivoCobradoCents)}</TableCell>
                              <TableCell className="text-right">{saldo(f.saldoCents)}</TableCell>
                              <TableCell><Badge variant="outline">{ESTADO[f.estado] ?? f.estado}</Badge></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </SoloEnPantallaAncha>
                  </>
                )}
      </Card>
    </div>
  )
}
