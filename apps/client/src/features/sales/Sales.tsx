import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as salesApi from './api'
import { Button } from '@botpanel/ui/components/button'
import { Card } from '@botpanel/ui/components/card'
import { Input } from '@botpanel/ui/components/input'
import { ConfirmAction } from '@botpanel/ui/components/confirm-action'

const { money } = salesApi

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('es-EC', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

export default function Sales() {
  // Prellenado desde Conversaciones (botón "Registrar venta" del chat)
  const [params] = useSearchParams()
  const prefillPhone = params.get('phone') ?? ''

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-foreground">Ventas</h1>
        <p className="text-sm text-muted-foreground">
          El historial de lo ya cobrado. Cada venta nace sola al entregar un pedido.
          El dueño no registra nada a mano.
        </p>
      </div>
      <SalesByContact prefillPhone={prefillPhone} />
    </div>
  )
}

// Lo que el local puede anular él mismo: lo que tecleó (mostrador o manual).
const anulaElLocal = (venta: salesApi.Sale) => ['mostrador', 'manual'].includes(String(venta.source ?? 'manual'))

// ── Ventas por contacto (ver + anular) ──
function SalesByContact({ prefillPhone = '' }: { prefillPhone?: string }) {
  const qc = useQueryClient()
  const [phone, setPhone] = useState(prefillPhone)
  // Con teléfono en la URL (desde Conversaciones) se busca solo: quien llega
  // así ya sabe de quién quiere ver las ventas.
  const [searched, setSearched] = useState(prefillPhone)

  const { data: sales = [], isFetching } = useQuery({
    queryKey: ['sales-by-phone', searched],
    queryFn: () => salesApi.getSalesByPhone(searched),
    enabled: !!searched,
  })

  const mVoid = useMutation({
    mutationFn: salesApi.voidSale,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales-by-phone', searched] }),
  })

  return (
    <div className="max-w-2xl">
      <form onSubmit={e => { e.preventDefault(); setSearched(phone.trim()) }} className="flex gap-2 mb-4">
        <Input id="sales-search-phone" aria-label="Teléfono del cliente" value={phone} onChange={e => setPhone(e.target.value)} placeholder="Teléfono del cliente (+593…)" className="flex-1" />
        <Button>Buscar</Button>
      </form>
      {isFetching && <p className="text-muted-foreground text-sm">Buscando…</p>}
      {searched && !isFetching && sales.length === 0 && <p className="text-muted-foreground text-sm">Sin ventas registradas para ese número.</p>}
      <div className="space-y-3">
        {sales.map(s => (
          <Card key={s.id} className={`p-4 gap-0 ${s.status === 'anulada' ? 'opacity-60' : ''}`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold text-foreground">{money(s.total)} {s.status === 'anulada' && <span className="text-xs font-normal text-red-500 ml-2">ANULADA</span>}</span>
              <span className="text-xs text-muted-foreground/80">{fmtDate(s.sold_at)}</span>
            </div>
            <div className="text-sm text-muted-foreground mt-1">
              {(s.sale_items ?? s.items ?? []).map((i, idx) => <div key={idx}>{i.quantity} × {i.product_name} — {money(i.line_total)}</div>)}
            </div>
            {/* ⚠️ Un pedido de la APP ya entregado solo lo anula Umbani
                (2026-10-11), como en las grandes: anularlo aquí le ahorraba al
                local la comisión. Lo exige la base; aquí solo se dice. */}
            {s.status === 'completada' && !anulaElLocal(s) && (
              <p className="mt-2 text-xs text-muted-foreground">
                Es un pedido de la app: si hubo un problema, escríbele a Umbani para anularlo.
              </p>
            )}
            {s.status === 'completada' && anulaElLocal(s) && (
              <ConfirmAction
                trigger={<Button variant="outline" size="sm" className="mt-2">Anular venta</Button>}
                title="Anular venta"
                description="La venta se marcará como anulada y dejará de contar en los reportes."
                confirmLabel="Anular venta"
                destructive
                onConfirm={() => mVoid.mutate(s.id)}
              />
            )}
          </Card>
        ))}
      </div>
    </div>
  )
}
