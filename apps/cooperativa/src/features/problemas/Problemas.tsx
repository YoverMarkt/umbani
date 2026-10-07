import { useQuery } from '@tanstack/react-query'
import { Badge } from '@botpanel/ui/components/badge'
import { Card } from '@botpanel/ui/components/card'
import { QueryError } from '@botpanel/ui/components/query-error'
import { Skeleton } from '@botpanel/ui/components/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'
import { api, dolares } from '../../api/client'
import { Dato, Ficha, Fichas, SoloEnPantallaAncha } from '../../components/Fichas'

// Los problemas de sus motorizados: las carreras retenidas (se le cayó la
// comida) y, desde el 2026-10-06, las incidencias de los pedidos que
// llevaban, con quién respondió. Sin datos de clientes.

type Retenida = {
  pedido: number | null; local: string | null; fecha: string; repartidor: string
  carreraCents: number; motivo: string | null; liquidada: boolean
}
type Incidencia = {
  pedido: number | null; local: string | null; fecha: string; repartidor: string
  tipo: string; estado: 'abierta' | 'resuelta' | 'descartada'; responsable: string | null
}

const getProblemas = () =>
  api<{ retenidas?: Retenida[]; incidencias?: Incidencia[] }>('/api/cooperativa/problemas')
    .then(r => ({ retenidas: r?.retenidas ?? [], incidencias: r?.incidencias ?? [] }))

const TIPOS: Record<string, string> = {
  falta_producto: 'Faltó un producto', vino_mal: 'Vino mal o era otro', no_llego: 'No llegó',
  comida_caida: 'Se cayó o se dañó la comida', cliente_ausente: 'El cliente no estaba',
  accidente: 'Accidente o robo', no_aparecio: 'El repartidor no apareció', otro: 'Otro',
}
const RESPONDE: Record<string, string> = {
  local: 'el local', repartidor: 'tu repartidor', cliente: 'el cliente', umbani: 'Umbani',
}
const comoQuedo = (i: Incidencia) => (
  i.estado === 'abierta' ? 'Umbani lo está revisando'
    : i.estado === 'descartada' ? 'Descartada: no hubo problema'
      : `Respondió ${RESPONDE[i.responsable ?? ''] ?? 'Umbani'}`
)

const fecha = (iso: string) => new Date(iso).toLocaleDateString('es-EC', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export default function Problemas() {
  const consulta = useQuery({ queryKey: ['problemas'], queryFn: getProblemas })
  const retenidas = consulta.data?.retenidas
  const incidencias = consulta.data?.incidencias

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Problemas</h1>
        <p className="text-sm text-muted-foreground">
          Lo que salió mal en los pedidos de tus repartidores, y quién respondió. Cuando a uno se le cae la comida,
          Umbani le retiene la carrera de ese pedido: no se le paga el lunes, y el local cobra su comida igual.
        </p>
      </div>
      <h2 className="text-base font-semibold text-foreground">Carreras retenidas</h2>
      {consulta.isError
        ? <QueryError onRetry={() => consulta.refetch()} />
        : !retenidas
          ? <Skeleton className="h-40 w-full" />
          : (
            <Card className="p-0">
              {!retenidas.length
                ? <p className="p-4 text-sm text-muted-foreground">Ninguna carrera retenida. Así se trabaja.</p>
                : (
                  <>
                    <Fichas>
                      {retenidas.map((r, i) => (
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
                        {retenidas.map((r, i) => (
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
      <h2 className="pt-2 text-base font-semibold text-foreground">Incidencias</h2>
      {incidencias && (
        <Card className="p-0">
          {!incidencias.length
            ? <p className="p-4 text-sm text-muted-foreground">Ninguna incidencia en los pedidos de tus repartidores.</p>
            : (
              <div className="divide-y divide-border">
                {incidencias.map((i, n) => (
                  <Ficha key={`${i.pedido}-${n}`} titulo={`${i.pedido ? `#${i.pedido}` : 'Pedido'} · ${i.local || 'Local'}`}
                    detalle={`${fecha(i.fecha)} · ${i.repartidor}`}
                    derecha={<Badge variant={i.estado === 'abierta' ? 'default' : 'outline'}>{TIPOS[i.tipo] ?? i.tipo}</Badge>}>
                    <p className="text-sm text-foreground">{comoQuedo(i)}</p>
                  </Ficha>
                ))}
              </div>
            )}
        </Card>
      )}
    </div>
  )
}
