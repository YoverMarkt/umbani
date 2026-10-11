import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@botpanel/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@botpanel/ui/components/dialog'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import { Textarea } from '@botpanel/ui/components/textarea'
import { getClients } from '../clients/api'
import { anularVenta } from './api'

// ═══════════════════════════════════════════════════════════════════════════
// ANULAR UNA VENTA (2026-10-11)
// ═══════════════════════════════════════════════════════════════════════════
//
// Decisión del dueño, «como las grandes»: un pedido de la app ya entregado
// solo lo anula Umbani. Hasta hoy lo anulaba el local desde su panel y, en
// efectivo, se ahorraba la comisión sin dejar rastro. Aquí se elige el local y
// el número del pedido (como en «Registrar» de Incidencias), con motivo: la
// base ajusta el libro sola y lo anota en el Registro con quién fue.

export default function AnularVenta() {
  const qc = useQueryClient()
  const [abierto, setAbierto] = useState(false)
  const [datos, setDatos] = useState({ localId: '', numero: '', motivo: '' })
  // La misma lista que usa Incidencias: se pide al abrir, no al entrar a Pagos.
  const locales = useQuery({ queryKey: ['adm-clients-min'], queryFn: getClients, enabled: abierto })

  const anular = useMutation({
    mutationFn: () => anularVenta({ localId: datos.localId, numero: Number(datos.numero), motivo: datos.motivo.trim() }),
    onSuccess: (r) => {
      toast.success(`Venta del pedido #${r.numero} anulada`)
      setAbierto(false)
      setDatos({ localId: '', numero: '', motivo: '' })
      void qc.invalidateQueries({ queryKey: ['adm-pagos'] })
      void qc.invalidateQueries({ queryKey: ['adm-pagos-registro'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setAbierto(true)}>Anular una venta</Button>
      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Anular una venta</DialogTitle>
            <DialogDescription>
              Un pedido de la app ya entregado solo lo anula Umbani. La venta sale de la semana del local (o se le
              resta en la próxima, si ya se liquidó) y queda en el Registro con tu nombre y el motivo.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div>
              <Label htmlFor="anular-local">Local</Label>
              <Select value={datos.localId || 'ninguno'} onValueChange={v => setDatos({ ...datos, localId: v === 'ninguno' ? '' : v })}>
                <SelectTrigger id="anular-local" className="mt-1 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ninguno">Elige el local</SelectItem>
                  {(locales.data || []).map(l => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="anular-numero">Número del pedido</Label>
              <Input id="anular-numero" inputMode="numeric" value={datos.numero} placeholder="41" onChange={e => setDatos({ ...datos, numero: e.target.value.replace(/\D/g, '') })} />
            </div>
            <div>
              <Label htmlFor="anular-motivo">Motivo</Label>
              <Textarea id="anular-motivo" rows={3} value={datos.motivo} placeholder="Por qué se anula" onChange={e => setDatos({ ...datos, motivo: e.target.value })} />
            </div>
          </div>
          <Button
            variant="destructive"
            disabled={anular.isPending || !datos.localId || !datos.numero || datos.motivo.trim().length < 3}
            onClick={() => anular.mutate()}
          >
            Anular la venta
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )
}
