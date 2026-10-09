import type { OptionGroup, OptionGroupPayload } from './api'

// Lo que comparten las pantallas de los grupos de opciones: el grupo nuevo, su resumen, mover en la lista y el precio.
// Vivía en OptionsManager.tsx hasta el 2026-10-08 (ningún archivo pasa de 1.000 líneas).

export const grupoNuevo = (): OptionGroupPayload => ({
  product_id: null,
  category_id: null,
  name: '',
  description: null,
  selection_type: 'single',
  required: false,
  min_selectable: 0,
  max_selectable: 1,
  max_total_quantity: null,
  pricing_strategy: 'sum',
  free_selections: 0,
  option_template_id: null,
  sort: 0,
  active: true,
  is_meal_part: false,
  loose_price: null,
})

/** El resumen que el dueño lee de un vistazo, en las mismas palabras que verá el cliente. */
export function resumen(grupo: OptionGroup): string {
  const minimo = Math.max(grupo.required ? 1 : 0, grupo.min_selectable)
  if (grupo.selection_type === 'quantity') {
    return minimo > 0
      ? `Reparte ${minimo === grupo.max_selectable ? minimo : `de ${minimo} a ${grupo.max_selectable}`} porciones`
      : `Hasta ${grupo.max_selectable} porciones`
  }
  if (grupo.selection_type === 'single') return minimo > 0 ? 'Elige 1' : 'Puede elegir 1'
  if (minimo > 0 && minimo === grupo.max_selectable) return `Elige exactamente ${minimo}`
  if (minimo > 0) return `Elige entre ${minimo} y ${grupo.max_selectable}`
  return `Hasta ${grupo.max_selectable}`
}

/**
 * Mueve un elemento una posición y devuelve la lista nueva de ids.
 *
 * Se manda la lista ENTERA al servidor y no «este sube uno»: dos toques
 * seguidos con la lista de por medio dejarían un orden que nadie pidió, y el
 * servidor tendría que adivinar desde dónde se movía.
 */
export function moverEnLista<T extends { id: string }>(
  lista: T[], indice: number, direccion: -1 | 1,
): string[] {
  const destino = indice + direccion
  // En los bordes se devuelve el orden actual: así quien llama puede comparar
  // y no gastar una petición en un movimiento que no mueve nada.
  if (destino < 0 || destino >= lista.length) return lista.map(item => item.id)
  const copia = [...lista]
  const [movido] = copia.splice(indice, 1)
  copia.splice(destino, 0, movido)
  return copia.map(item => item.id)
}

export const money = (valor: string | number) => {
  const n = Number(valor) || 0
  if (n === 0) return 'sin recargo'
  return `${n > 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`
}
