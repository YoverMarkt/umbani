import { useState } from 'react'
import { Button } from '@botpanel/ui/components/button'
import { Input } from '@botpanel/ui/components/input'
import { Textarea } from '@botpanel/ui/components/textarea'
import { Label } from '@botpanel/ui/components/label'
import { Checkbox } from '@botpanel/ui/components/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@botpanel/ui/components/select'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@botpanel/ui/components/dialog'
import type {
  Category, OptionGroup, OptionGroupPayload, OptionTemplate, PricingStrategy, Product, SelectionType,
} from './api'
import { grupoNuevo, resumen } from './opciones'

// El formulario de un GRUPO de opciones.
// Vivía en OptionsManager.tsx hasta el 2026-10-08 (ningún archivo pasa de 1.000 líneas).

const TIPOS: { value: SelectionType; label: string; ayuda: string }[] = [
  { value: 'single', label: 'Elegir uno', ayuda: 'Un círculo. Tamaño, término, masa.' },
  { value: 'multiple', label: 'Elegir varios', ayuda: 'Casillas con tope. Salsas, ingredientes.' },
  { value: 'quantity', label: 'Por cantidad', ayuda: 'Un contador por opción. Cortes, bolas de helado.' },
]

const ESTRATEGIAS: { value: PricingStrategy; label: string; ayuda: string }[] = [
  { value: 'sum', label: 'Suma cada opción', ayuda: 'Lo normal: cada extra suma su recargo.' },
  { value: 'highest_selected', label: 'Cobra la más cara', ayuda: 'Mitad y mitad: media Suprema y media Hawaiana cuestan lo que la Suprema.' },
  { value: 'lowest_selected', label: 'Cobra la más barata', ayuda: 'Lo contrario: manda la opción de menor precio.' },
  { value: 'average', label: 'Cobra el promedio', ayuda: 'El promedio de lo elegido.' },
  { value: 'included', label: 'Todo incluido', ayuda: 'No suma nada aunque las opciones tengan precio.' },
  { value: 'included_up_to_limit', label: 'Las primeras van incluidas', ayuda: 'Las primeras N sin recargo; a partir de ahí, suman.' },
  { value: 'extra_after_limit', label: 'Cobra a partir del límite', ayuda: 'Igual, con el límite que definas abajo.' },
  { value: 'fixed', label: 'No altera el precio', ayuda: 'El grupo es informativo.' },
]

export function GrupoDialog({
  estado, productos, categorias, plantillas, onCerrar, onGuardar, guardando,
}: {
  estado: { grupo: OptionGroupPayload; id: string | null } | null
  productos: Product[]
  categorias: Category[]
  plantillas: OptionTemplate[]
  onCerrar: () => void
  onGuardar: (valor: { grupo: OptionGroupPayload; id: string | null }) => void
  guardando: boolean
}) {
  const [borrador, setBorrador] = useState<OptionGroupPayload>(grupoNuevo())
  const [ultimo, setUltimo] = useState<string | null>(null)

  const clave = estado ? `${estado.id || 'nuevo'}` : null
  if (clave !== ultimo) {
    setUltimo(clave)
    if (estado) setBorrador({ ...estado.grupo })
  }

  if (!estado) return null

  const cambiar = (parcial: Partial<OptionGroupPayload>) => setBorrador({ ...borrador, ...parcial })

  const cambiarTipo = (tipo: SelectionType) => {
    // Un radio con máximo 5 obligaría a la app a decidir a quién cree.
    cambiar({ selection_type: tipo, max_selectable: tipo === 'single' ? 1 : borrador.max_selectable })
  }

  const cambiarObligatorio = (valor: boolean) => {
    // Un «obligatorio» con mínimo 0 no obliga a nada.
    cambiar({ required: valor, min_selectable: valor ? Math.max(1, borrador.min_selectable) : borrador.min_selectable })
  }

  const conLimite = borrador.pricing_strategy === 'included_up_to_limit'
    || borrador.pricing_strategy === 'extra_after_limit'
  const destino = borrador.product_id ? 'producto' : borrador.category_id ? 'categoria' : ''
  const listo = Boolean(borrador.name.trim()) && Boolean(destino)

  return (
    <Dialog open onOpenChange={abierta => !abierta && onCerrar()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{estado.id ? 'Editar grupo' : 'Nuevo grupo de opciones'}</DialogTitle>
          <DialogDescription>
            Así se personaliza el plato en tu mini app.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="grupo-nombre">Nombre del grupo</Label>
            <Input
              id="grupo-nombre"
              value={borrador.name}
              onChange={e => cambiar({ name: e.target.value })}
              placeholder="Término de la carne"
            />
          </div>

          <div className="space-y-2">
            <Label>¿A qué se le aplica?</Label>
            <Select
              value={destino === 'producto' ? `p:${borrador.product_id}`
                : destino === 'categoria' ? `c:${borrador.category_id}` : ''}
              onValueChange={(valor) => {
                const [tipo, id] = valor.split(':')
                cambiar(tipo === 'p'
                  ? { product_id: id, category_id: null }
                  : { product_id: null, category_id: id })
              }}
            >
              <SelectTrigger><SelectValue placeholder="Elige un producto o una categoría" /></SelectTrigger>
              <SelectContent>
                {categorias.map(c => (
                  <SelectItem key={`c:${c.id}`} value={`c:${c.id}`}>
                    Toda la categoría {c.name}
                  </SelectItem>
                ))}
                {productos.map(p => (
                  <SelectItem key={`p:${p.id}`} value={`p:${p.id}`}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Por categoría lo heredan todos sus productos: así 19 sabores sirven para todas las
              productos sin repetirlos en cada uno.
            </p>
          </div>

          <div className="space-y-2">
            <Label>¿Cómo elige el cliente?</Label>
            <Select value={borrador.selection_type} onValueChange={v => cambiarTipo(v as SelectionType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TIPOS.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {TIPOS.find(t => t.value === borrador.selection_type)?.ayuda}
            </p>
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border p-3">
            <Checkbox
              id="grupo-obligatorio"
              checked={borrador.required}
              onCheckedChange={v => cambiarObligatorio(v === true)}
            />
            <div>
              <Label htmlFor="grupo-obligatorio">Es obligatorio</Label>
              <p className="text-xs text-muted-foreground">
                El cliente no podrá agregar el producto al carrito sin elegir aquí.
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="grupo-min">Mínimo</Label>
              <Input
                id="grupo-min" type="number" min={borrador.required ? 1 : 0} max={100}
                value={borrador.min_selectable}
                onChange={e => cambiar({ min_selectable: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="grupo-max">Máximo</Label>
              <Input
                id="grupo-max" type="number" min={1} max={100}
                disabled={borrador.selection_type === 'single'}
                value={borrador.max_selectable}
                onChange={e => cambiar({ max_selectable: Number(e.target.value) })}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            El cliente verá: <strong>{resumen({ ...borrador, id: '' } as OptionGroup)}</strong>
          </p>

          <div className="space-y-2">
            <Label>¿Cómo se cobra?</Label>
            <Select
              value={borrador.pricing_strategy}
              onValueChange={(v) => {
                const estrategia = v as PricingStrategy
                const necesitaLimite = estrategia === 'included_up_to_limit'
                  || estrategia === 'extra_after_limit'
                cambiar({
                  pricing_strategy: estrategia,
                  free_selections: necesitaLimite ? Math.max(1, borrador.free_selections) : 0,
                })
              }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ESTRATEGIAS.map(e => <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {ESTRATEGIAS.find(e => e.value === borrador.pricing_strategy)?.ayuda}
            </p>
          </div>

          {conLimite && (
            <div className="space-y-2">
              <Label htmlFor="grupo-gratis">¿Cuántas van sin recargo?</Label>
              <Input
                id="grupo-gratis" type="number" min={1} max={100}
                value={borrador.free_selections}
                onChange={e => cambiar({ free_selections: Number(e.target.value) })}
              />
            </div>
          )}

          {plantillas.length > 0 && (
            <div className="space-y-2">
              <Label>Usar una plantilla (opcional)</Label>
              <Select
                value={borrador.option_template_id || 'ninguna'}
                onValueChange={v => cambiar({ option_template_id: v === 'ninguna' ? null : v })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ninguna">Sin plantilla — opciones propias</SelectItem>
                  {plantillas.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="grupo-desc">Aclaración para el cliente (opcional)</Label>
            <Textarea
              id="grupo-desc" rows={2}
              value={borrador.description || ''}
              onChange={e => cambiar({ description: e.target.value || null })}
              placeholder="Elige cómo quieres tu carne"
            />
          </div>

          <div className="flex items-center gap-2.5">
            <Checkbox
              id="grupo-activo"
              checked={borrador.active}
              onCheckedChange={v => cambiar({ active: v === true })}
            />
            <Label htmlFor="grupo-activo">Visible en la mini app</Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCerrar}>Cancelar</Button>
          <Button
            disabled={!listo || guardando}
            onClick={() => onGuardar({ grupo: borrador, id: estado.id })}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── El formulario de la opción ─────────────────────────────────────────────
