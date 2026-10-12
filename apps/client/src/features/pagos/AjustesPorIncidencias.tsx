import { Card, CardContent, CardHeader, CardTitle } from '@botpanel/ui/components/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@botpanel/ui/components/table'

// ═══════════════════════════════════════════════════════════════════════════
// LOS AJUSTES POR INCIDENCIAS DE LA SEMANA (2026-10-12)
// ═══════════════════════════════════════════════════════════════════════════
//
// Como las grandes: si un pedido tuvo un problema y respondía el local, en su
// depósito se le descuenta lo que se le devolvió al cliente, menos la comisión
// de Umbani; si perdió la comida antes de entregar por algo que no fue suyo,
// se le paga. Cada uno con su porqué: un descuento sin explicación es un
// reclamo seguro. Lo calcula la base; aquí solo se pinta.

export type AjusteDelLocal = {
  numero: number | null
  fecha: string
  tipo: string | null
  concepto: 'reclamo' | 'no_cobro' | 'comida_reconocida' | 'comida_cobrada'
  cents: number
}

const QUE_PASO: Record<string, string> = {
  falta_producto: 'Faltó un producto',
  vino_mal: 'Vino mal o era otro',
  no_llego: 'No llegó',
  comida_caida: 'Se cayó o se dañó la comida',
  cliente_ausente: 'El cliente no estaba',
  accidente: 'Accidente o robo',
  no_aparecio: 'El repartidor no apareció',
  otro: 'Otro',
}

const POR_QUE: Record<AjusteDelLocal['concepto'], string> = {
  reclamo: 'Lo que se le devolvió al cliente, menos la comisión de Umbani',
  no_cobro: 'El pedido no llegó: ese efectivo no lo cobraste',
  comida_reconocida: 'Umbani te paga la comida que perdiste',
  comida_cobrada: 'La comida que se perdió',
}

const conSigno = (centavos: number) => (centavos < 0 ? '−$' : '+$')
  + (Math.abs(centavos) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const dia = (iso: string) => new Date(iso).toLocaleDateString('es-EC', { day: '2-digit', month: 'short' })

export default function AjustesPorIncidencias({ ajustes }: { ajustes: AjusteDelLocal[] }) {
  if (!ajustes.length) return null
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Ajustes por incidencias</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pedido</TableHead>
              <TableHead>Qué pasó</TableHead>
              <TableHead className="text-right">En tu depósito</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ajustes.map((a, i) => (
              <TableRow key={`${a.numero}-${a.concepto}-${i}`}>
                <TableCell>
                  <div className="font-medium">#{a.numero ?? '—'}</div>
                  <div className="text-xs text-muted-foreground">{dia(a.fecha)}</div>
                </TableCell>
                <TableCell>
                  <div>{QUE_PASO[a.tipo || ''] || 'Incidencia'}</div>
                  <div className="text-xs text-muted-foreground">{POR_QUE[a.concepto]}</div>
                </TableCell>
                <TableCell className={`text-right font-semibold tabular-nums ${a.cents < 0 ? 'text-destructive' : 'text-foreground'}`}>
                  {conSigno(a.cents)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
