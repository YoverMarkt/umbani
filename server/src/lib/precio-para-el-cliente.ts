// ═══════════════════════════════════════════════════════════════════════════
// LO QUE VE EL CLIENTE: SUS PRECIOS, NUNCA LOS DEL LOCAL NI EL MARGEN
// ═══════════════════════════════════════════════════════════════════════════
//
// Decisión del dueño (2026-10-01): «esconderlo». Hasta ese día, lo que recibía
// el teléfono del cliente traía el precio del LOCAL y el porcentaje de Umbani:
//
//   · la cotización: `merchantSubtotal`, `platformMarkup`, `markupPercentage`
//     y cada línea con el precio del local;
//   · el seguimiento de un pedido: cada línea con el precio del local, así que
//     quien volvía a un pedido pendiente leía «Agua $0,75» cuando pagó $0,83, y
//     las líneas no sumaban el total.
//
// Aquí se reparte lo que el cliente paga por los productos entre las líneas, y
// las dos promesas de este archivo son:
//
//   1. las líneas SUMAN exactamente lo que paga el cliente por los productos;
//   2. con un margen por producto (`on_top` + `percentage`, sin topes) cada
//      línea es la MISMA que vio en la carta: la aritmética de
//      `order_markup_by_line` (redondear el margen del precio unitario y
//      multiplicar por la cantidad), en centavos enteros.
//
// Con cualquier otra regla (fija, por tramos, con topes) el margen es del
// PEDIDO entero y no tiene precio por producto: se reparte en proporción a lo
// de cada línea, y los centavos sueltos van a las de mayor resto. Las líneas
// siguen sumando el total; solo pueden diferir un centavo de la carta.

export const centavos = (monto: unknown): number => Math.round((Number(monto) || 0) * 100)

/** El porcentaje POR PRODUCTO de una regla, o `null` si es una cantidad del pedido. */
export function porcentajePorProducto(regla: {
  markupMode?: string | null
  strategy?: string | null
  percentage?: number | null
  minAmount?: number | null
  maxAmount?: number | null
} | null | undefined): number | null {
  if (!regla || regla.markupMode !== 'on_top' || regla.strategy !== 'percentage') return null
  if (regla.minAmount != null || regla.maxAmount != null) return null
  const pct = Number(regla.percentage)
  return Number.isFinite(pct) && pct >= 0 ? pct : null
}

/**
 * Lo que paga el cliente por cada línea, en centavos, sumando EXACTAMENTE
 * `clienteCents`.
 *
 * @param localCents lo que cobra el local por cada línea
 * @param cantidades las unidades de cada línea
 * @param clienteCents lo que paga el cliente por todos los productos
 * @param pct el porcentaje por producto, si la regla lo tiene
 */
export function repartirParaElCliente(
  localCents: number[],
  cantidades: number[],
  clienteCents: number,
  pct: number | null,
): number[] {
  if (!localCents.length) return []

  // 1. Margen por producto: lo mismo que la carta y que la base.
  if (pct !== null) {
    const porProducto = localCents.map((linea, i) => {
      const unidades = cantidades[i] > 0 ? cantidades[i] : 1
      const unitario = Math.round(linea / unidades)
      return linea + Math.round((unitario * pct) / 100) * unidades
    })
    // Solo vale si cuadra con lo que se cobró. Si la regla cambió después del
    // pedido, deja de cuadrar y se reparte en proporción (paso 2).
    if (porProducto.reduce((t, v) => t + v, 0) === clienteCents) return porProducto
  }

  // 2. En proporción, con los centavos sueltos para los mayores restos.
  const base = localCents.reduce((t, v) => t + v, 0)
  const extra = clienteCents - base
  if (base <= 0) {
    const reparto = localCents.map(() => 0)
    reparto[0] = clienteCents
    return reparto
  }
  const exactos = localCents.map(linea => (extra * linea) / base)
  const enteros = exactos.map(Math.floor)
  let sueltos = extra - enteros.reduce((t, v) => t + v, 0)
  const porResto = exactos
    .map((exacto, i) => ({ i, resto: exacto - enteros[i] }))
    .sort((a, b) => b.resto - a.resto || a.i - b.i)
  for (const { i } of porResto) {
    if (sueltos <= 0) break
    enteros[i] += 1
    sueltos -= 1
  }
  return localCents.map((linea, i) => linea + enteros[i])
}

// ── La cotización ───────────────────────────────────────────────────────────

interface LineaCotizada {
  productId: string
  name: string
  quantity: number
  unitPrice: number
  lineTotal: number
  options: { name: string; groupName: string; quantity: number; price?: number }[]
}

/**
 * La cotización tal como la recibe el teléfono: líneas con SU precio,
 * `subtotal` (lo de los productos), envío, tarifa y total. Suman siempre:
 * subtotal + shipping + serviceFee = total.
 */
export function cotizacionParaElCliente(
  cotizacion: {
    lines: LineaCotizada[]
    shipping: number
    total: number
    serviceFee: number
    customerSubtotal: number
  },
  pct: number | null,
) {
  const lineas = repartirParaElCliente(
    cotizacion.lines.map(l => centavos(l.lineTotal)),
    cotizacion.lines.map(l => l.quantity),
    centavos(cotizacion.customerSubtotal),
    pct,
  )
  return {
    lines: cotizacion.lines.map((linea, i) => ({
      productId: linea.productId,
      name: linea.name,
      quantity: linea.quantity,
      // Con margen por producto es exacto; repartido en proporción, el
      // `lineTotal` es el que manda.
      unitPrice: Math.round(lineas[i] / (linea.quantity > 0 ? linea.quantity : 1)) / 100,
      lineTotal: lineas[i] / 100,
      // Sin el recargo de cada opción: estaba en precio del LOCAL.
      options: (linea.options || []).map(({ name, groupName, quantity }) => ({ name, groupName, quantity })),
    })),
    subtotal: cotizacion.customerSubtotal,
    shipping: cotizacion.shipping,
    serviceFee: cotizacion.serviceFee,
    total: cotizacion.total,
  }
}

// ── El pedido guardado ──────────────────────────────────────────────────────

/** Lo que NUNCA sale hacia el cliente de una fila de `orders`. */
const INTERNOS = ['merchant_subtotal', 'platform_markup', 'pricing_rule_id', 'pricing_rule_version'] as const

/**
 * Un pedido tal como lo ve su cliente: cada línea con lo que pagó él, el
 * `subtotal` de sus productos y la tarifa aparte, sin nada del local ni del
 * margen. Todo sale de lo que la base CONGELÓ al crearlo.
 */
export function pedidoParaElCliente(
  pedido: Record<string, unknown> | null | undefined,
  pct: number | null,
): Record<string, unknown> | null | undefined {
  if (!pedido) return pedido
  const items = Array.isArray(pedido.order_items) ? pedido.order_items as Record<string, unknown>[] : []
  const tarifaCents = centavos(pedido.service_fee)
  const clienteCents = centavos(pedido.total) - centavos(pedido.shipping) - tarifaCents
  const lineas = repartirParaElCliente(
    items.map(item => centavos(item.line_total)),
    items.map(item => Number(item.quantity) || 1),
    clienteCents,
    pct,
  )
  const limpio: Record<string, unknown> = { ...pedido }
  for (const clave of INTERNOS) delete limpio[clave]
  return {
    ...limpio,
    subtotal: clienteCents / 100,
    service_fee: tarifaCents / 100,
    order_items: items.map((item, i) => ({ ...item, line_total: lineas[i] / 100 })),
  }
}
