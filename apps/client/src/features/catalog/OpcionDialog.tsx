import { useState } from 'react'
import { useBusinessInfo } from '../../lib/biz'
import { vocabularioDe } from './vocabulario'
import { Button } from '@botpanel/ui/components/button'
import { Input } from '@botpanel/ui/components/input'
import { Label } from '@botpanel/ui/components/label'
import { Checkbox } from '@botpanel/ui/components/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@botpanel/ui/components/dialog'
import type { Product, ProductOption } from './api'

// El formulario de UNA opción.
// Vivía en OptionsManager.tsx hasta el 2026-10-08 (ningún archivo pasa de 1.000 líneas).

export function OpcionDialog({
  estado, productos, onCerrar, onGuardar, guardando,
}: {
  estado: { opcion: Omit<ProductOption, 'id'>; id: string | null } | null
  productos: Product[]
  onCerrar: () => void
  onGuardar: (valor: { opcion: Omit<ProductOption, 'id'>; id: string | null }) => void
  guardando: boolean
}) {
  const voz = vocabularioDe(useBusinessInfo().data?.type)
  const [borrador, setBorrador] = useState<Omit<ProductOption, 'id'> | null>(null)
  const [ultimo, setUltimo] = useState<string | null>(null)

  const clave = estado ? `${estado.id || 'nueva'}:${estado.opcion.option_group_id}` : null
  if (clave !== ultimo) {
    setUltimo(clave)
    if (estado) setBorrador({ ...estado.opcion })
  }

  if (!estado || !borrador) return null

  const cambiar = (parcial: Partial<ProductOption>) => setBorrador({ ...borrador, ...parcial })

  return (
    <Dialog open onOpenChange={abierta => !abierta && onCerrar()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{estado.id ? 'Editar opción' : 'Nueva opción'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="opcion-nombre">Nombre</Label>
            <Input
              id="opcion-nombre"
              value={borrador.name}
              onChange={e => cambiar({ name: e.target.value })}
              placeholder="Bien cocida"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="opcion-precio">Recargo</Label>
            <Input
              id="opcion-precio" type="number" step="0.01"
              value={String(borrador.price_adjustment)}
              onChange={e => cambiar({ price_adjustment: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Cero si va incluida. Puede ser <strong>negativo</strong>: «sin sopa −0.50» descuenta
              del precio del plato.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Es este producto del catálogo (opcional)</Label>
            <Select
              value={borrador.references_product_id || 'ninguno'}
              onValueChange={v => cambiar({ references_product_id: v === 'ninguno' ? null : v })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ninguno">No, es una opción suelta</SelectItem>
                {productos.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Así se arman los combos: «{voz.ejemploGrupo}» son opciones que apuntan a
              productos reales de tu catálogo.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="opcion-desc">Descripción (opcional)</Label>
            <Input
              id="opcion-desc"
              value={borrador.description || ''}
              onChange={e => cambiar({ description: e.target.value || null })}
            />
          </div>

          <div className="flex flex-wrap gap-5">
            <div className="flex items-center gap-2.5">
              <Checkbox
                id="opcion-defecto"
                checked={borrador.default_selected}
                onCheckedChange={v => cambiar({ default_selected: v === true })}
              />
              <Label htmlFor="opcion-defecto">Viene marcada</Label>
            </div>
            <div className="flex items-center gap-2.5">
              <Checkbox
                id="opcion-agotada"
                checked={borrador.stock === 'agotado'}
                onCheckedChange={v => cambiar({ stock: v === true ? 'agotado' : 'disponible' })}
              />
              <Label htmlFor="opcion-agotada">Agotada</Label>
            </div>
            <div className="flex items-center gap-2.5">
              <Checkbox
                id="opcion-activa"
                checked={borrador.active}
                onCheckedChange={v => cambiar({ active: v === true })}
              />
              <Label htmlFor="opcion-activa">Visible</Label>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCerrar}>Cancelar</Button>
          <Button
            disabled={!borrador.name.trim() || guardando}
            onClick={() => onGuardar({ opcion: borrador, id: estado.id })}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
