import { useQuery } from '@tanstack/react-query'
import { Badge } from '@botpanel/ui/components/badge'
import { Card } from '@botpanel/ui/components/card'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { api, dolares } from '../../api/client'
import { Dato, Ficha, Fichas, SoloEnPantallaAncha } from '../../components/Fichas'

// Los problemas de sus motorizados. Por ahora, las carreras retenidas (se le
// cayó la comida). Las demás incidencias —cliente ausente, faltó un producto,
// accidente— llegan con su propio módulo. Sin datos de clientes.

type Retenida = {
  pedido: number | null; local: string | null; fecha: string; repartidor: string
  carreraCents: number; motivo: string | null; liquidada: boolean
}

const getProblemas = () =>
  api<{ retenidas?: Retenida[] }>('/api/cooperativa/problemas').then(r => r?.retenidas ?? [])

const fecha = (iso: string) => new Date(iso).toLocaleDateString('es-EC', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export default function Problemas() {
  const consulta = useQuery({ queryKey: ['problemas'], queryFn: getProblemas })

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Problemas</h1>
        <p className="text-sm text-muted-foreground">
          Cuando a un repartidor se le cae la comida, Umbani le retiene la carrera de ese pedido: no se le paga el
          lunes. El local cobra su comida igual.
        </p>
      </div>
      {consulta.isError
        ? <QueryError onRetry={() => consulta.refetch()} />
        : !consulta.data
          ? <Skeleton className="h-40 w-full" />
          : (
            <Card className="p-0">
              {!consulta.data.length
                ? <p className="p-4 text-sm text-muted-foreground">Ningún problema. Así se trabaja.</p>
                : (
                  <>
                    <Fichas>
                      {consulta.data.map((r, i) => (
                        <Ficha key={`${r.pedido}-${i}`} titulo={`${r.pedido ? `#${r.pedido}` : 'Pedido'} · ${r.local || 'Local'}`}
                          detalle={`${fecha(r.fecha)} · ${r.repartidor}`}
                          derecha={<Badge variant="outline">{r.liquidada ? 'Ya descontada' : 'Se descuenta el lunes'}</Badge>}>
                          <Dato nombre="Carrera retenida" valor={dolares(r.carreraCents)} />
                          {r.motivo && <p className="text-sm text-foreground">{r.motivo}</p>}
                        </Ficha>
                      ))}
                    </Fichas>
                    <SoloEnPantallaAncha>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Pedido</TableHead>
                          <TableHead>Repartidor</TableHead>
                          <TableHead>Motivo</TableHead>
                          <TableHead className="text-right">Carrera retenida</TableHead>
                          <TableHead>Estado</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {consulta.data.map((r, i) => (
                          <TableRow key={`${r.pedido}-${i}`}>
                            <TableCell>
                              <div className="font-medium">{r.pedido ? `#${r.pedido}` : 'Pedido'} · {r.local || 'Local'}</div>
                              <div className="text-xs text-muted-foreground">{fecha(r.fecha)}</div>
                            </TableCell>
                            <TableCell>{r.repartidor}</TableCell>
                            <TableCell className="max-w-72 whitespace-normal">{r.motivo || '—'}</TableCell>
                            <TableCell className="text-right tabular-nums">{dolares(r.carreraCents)}</TableCell>
                            <TableCell>
                              <Badge variant="outline">{r.liquidada ? 'Ya descontada' : 'Se descuenta el lunes'}</Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    </SoloEnPantallaAncha>
                  </>
                )}
            </Card>
          )}
      <p className="text-xs text-muted-foreground">
        Pronto: las demás incidencias (cliente ausente, un producto que faltó, un accidente), con quién responde
        por cada una.
      </p>
    </div>
  )
}
