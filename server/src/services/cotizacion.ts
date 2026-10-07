import { enHorarioDeProducto } from './schedule'
import { buildMealLines, calculateProductPrice, type MealChoice, type PricingStrategy } from './pricing'
import { calculatePlatformMarkup, type MarkupRule } from './platform-pricing'
import {
  disponible, money, type CatalogOption, type CatalogOptionGroup, type CatalogProduct, type CatalogVariant,
} from './storefront'

// ═══════════════════════════════════════════════════════════════════════════
// LA COTIZACIÓN DEL CARRITO (vivía en `services/storefront.ts` hasta el 2026-10-07)
// ═══════════════════════════════════════════════════════════════════════════
//
// Se separó cuando aquel archivo pasó de 1.000 líneas. Depende de la carta (sus
// tipos y cómo lee un precio o el stock) y la carta no depende de ella.
// ⚠️ Solo COTIZA: el importe oficial lo cierra `create_storefront_order` en la
// base, y esto replica su regla en centavos enteros (CLAUDE.md §4.8).

// ── Cotizar un carrito sin crear el pedido ──────────────────────────────────
//
// El total EXACTO que se va a cobrar, con su desglose, resuelto contra el
// catálogo del negocio. Lo pide el checkout justo antes de confirmar: la app
// calcula mientras el cliente elige —para que la pantalla responda al
// instante— pero el número que se enseña antes de pagar sale de aquí.
//
// Aplica el MISMO `pricing.ts` cuya lógica replica `create_storefront_order`.
// Si la cotización y el cobro difirieran, el cliente vería un número al
// confirmar y otro en el pedido.
//
// ⚠️ No es la autoridad: sigue siéndolo la RPC (regla inviolable #8). Esto no
// escribe ni reserva nada, así que un desajuste aquí se nota antes de cobrar.

export interface QuoteItemInput {
  productId?: unknown
  variantId?: unknown
  quantity?: unknown
  options?: unknown
}

export interface QuoteLine {
  productId: string
  name: string
  quantity: number
  unitPrice: number
  lineTotal: number
  options: { name: string; groupName: string; quantity: number; price: number }[]
}

export interface CartQuote {
  error?: string
  lines: QuoteLine[]
  subtotal: number
  /** Lo que recibe el comercio por sus productos: su precio, entero. */
  merchantSubtotal: number
  /** Lo que gana la plataforma sobre este pedido. */
  platformMarkup: number
  /** Lo que paga el cliente por los productos: con `on_top` incluye el margen. */
  customerSubtotal: number
  /** El porcentaje aplicado, para poder explicarlo después. */
  markupPercentage: number | null
  shipping: number
  /** La tarifa de servicio: la paga el cliente, es de Umbani. Va DENTRO de `platformMarkup`. */
  serviceFee: number
  total: number
}

const vacia = (error: string): CartQuote => ({
  error, lines: [], subtotal: 0, shipping: 0, total: 0, serviceFee: 0,
  merchantSubtotal: 0, platformMarkup: 0, customerSubtotal: 0, markupPercentage: null,
})

export function quoteCart(input: {
  items: QuoteItemInput[]
  products: CatalogProduct[]
  variants: CatalogVariant[]
  optionGroups: CatalogOptionGroup[]
  options: CatalogOption[]
  deliveryFee: number
  fulfillment: string
  /** La regla de margen vigente, la misma que sella el pedido. */
  pricing?: MarkupRule | null
  /** El momento que se cotiza. Se inyecta en las pruebas de las franjas. */
  now?: Date
  /** La tarifa de servicio vigente. La base la suma igual en `orders_stamp_pricing`. */
  serviceFee?: number | null
}): CartQuote {
  const porProducto = new Map(input.products.map(producto => [producto.id, producto]))
  const porVariante = new Map(input.variants.map(variante => [variante.id, variante]))
  const porGrupo = new Map(input.optionGroups.map(grupo => [grupo.id, grupo]))
  const porOpcion = new Map(input.options.map(opcion => [opcion.id, opcion]))

  const lines: QuoteLine[] = []
  let subtotal = 0

  for (const bruto of input.items) {
    const producto = porProducto.get(String(bruto.productId || ''))
    if (!producto) return vacia('Uno de los productos ya no está disponible')
    if (!disponible(producto.stock)) return vacia(`${producto.name} está agotado`)
    // Fuera de su franja no se cotiza, igual que lo rechazará la base.
    if (!enHorarioDeProducto(producto, input.now ?? new Date())) {
      return vacia(`${producto.name} no se puede pedir a esta hora`)
    }

    const cantidad = Math.trunc(Number(bruto.quantity) || 0)
    if (cantidad < 1 || cantidad > 99) return vacia('La cantidad no es válida')

    // El precio base sale de la variante si la hay; si no, del producto.
    let base = money(producto.price_sale) || money(producto.price) || 0
    const variante = bruto.variantId ? porVariante.get(String(bruto.variantId)) : null
    if (bruto.variantId && !variante) return vacia('Esa presentación ya no existe')
    if (variante) {
      if (variante.product_id !== producto.id) return vacia('Esa presentación no es de este producto')
      base = money(variante.price_sale) || money(variante.price) || 0
    }

    // Lo elegido, agrupado: cada grupo cobra con SU estrategia y para eso hay
    // que verlo entero, no opción por opción.
    const elegidasPorGrupo = new Map<string, { price: number; quantity: number }[]>()
    const detalle: QuoteLine['options'] = []

    for (const cruda of Array.isArray(bruto.options) ? bruto.options.slice(0, 30) : []) {
      const dato = (cruda || {}) as Record<string, unknown>
      const opcion = porOpcion.get(String(dato.optionId || dato.option_id || ''))
      if (!opcion) return vacia('Una de las opciones ya no está disponible')
      const grupo = porGrupo.get(opcion.option_group_id)
      if (!grupo) return vacia('Una de las opciones ya no está disponible')
      // La opción tiene que ser de un grupo de ESTE producto: suyo o de su
      // categoría. Es la misma frontera que aplica la RPC.
      const aplica = grupo.product_id === producto.id
        || (Boolean(grupo.category_id) && grupo.category_id === producto.category_id)
      if (!aplica) return vacia(`Una opción no corresponde a ${producto.name}`)
      if (!disponible(opcion.stock)) return vacia(`${opcion.name} ya no está disponible`)

      const porciones = Math.min(100, Math.max(1, Math.trunc(Number(dato.quantity) || 1)))
      const precio = money(opcion.price_adjustment) ?? 0
      elegidasPorGrupo.set(grupo.id, [
        ...elegidasPorGrupo.get(grupo.id) || [],
        { price: precio, quantity: porciones },
      ])
      detalle.push({
        name: opcion.name,
        groupName: grupo.name,
        quantity: porciones,
        price: precio,
      })
    }

    // ── El plato POR PARTES: la mesa entera se parte en sus líneas ────────
    //
    // Lo mismo que hace `lineas_del_plato_por_partes` dentro de la RPC, con
    // las mismas fronteras y los mismos textos: cotizar un almuerzo que la base
    // va a rechazar, o a cobrar distinto, sería enseñar un número que no existe.
    const gruposDelProducto = input.optionGroups.filter(grupo => grupo.product_id === producto.id
      || (Boolean(grupo.category_id) && grupo.category_id === producto.category_id))
    if (gruposDelProducto.some(grupo => grupo.is_meal_part === true && grupo.product_id === producto.id)) {
      if (cantidad !== 1 || variante) return vacia(`${producto.name} se arma en una sola línea`)
      // Dos líneas del mismo plato no se juntarían: la sopa en una y el
      // segundo en otra saldrían sueltos, por menos que el almuerzo.
      if (lines.some(linea => linea.productId === producto.id)) {
        return vacia(`${producto.name} va una sola vez en el pedido`)
      }
      if (!(base > 0)) return vacia(`${producto.name} quedaría sin precio válido`)

      const elecciones: MealChoice[] = (Array.isArray(bruto.options) ? bruto.options.slice(0, 30) : [])
        .flatMap((cruda) => {
          const dato = (cruda || {}) as Record<string, unknown>
          const opcion = porOpcion.get(String(dato.optionId || dato.option_id || ''))
          if (!opcion) return []
          return [{
            optionId: opcion.id,
            groupId: opcion.option_group_id,
            name: opcion.name,
            sort: opcion.sort ?? 0,
            quantity: Math.min(100, Math.max(1, Math.trunc(Number(dato.quantity) || 1))),
            price: money(opcion.price_adjustment) ?? 0,
          }]
        })
      const armado = buildMealLines({
        productName: producto.name,
        price: base,
        // Una parte con todo agotado deja de contar, igual que en la base.
        groups: gruposDelProducto
          .filter(grupo => grupo.is_meal_part !== true || input.options.some(opcion => (
            opcion.option_group_id === grupo.id && disponible(opcion.stock)
          )))
          .map(grupo => ({
            id: grupo.id,
            name: grupo.name,
            sort: grupo.sort ?? 0,
            isMealPart: grupo.is_meal_part === true,
            loosePrice: grupo.is_meal_part === true ? money(grupo.loose_price) : null,
          })),
        choices: elecciones,
      })
      if (armado.error !== undefined) return vacia(armado.error)

      for (const linea of armado.lines) {
        const totalDeLinea = Math.round(linea.unitPrice * linea.quantity * 100) / 100
        subtotal += totalDeLinea
        lines.push({
          productId: producto.id,
          name: linea.name,
          quantity: linea.quantity,
          unitPrice: linea.unitPrice,
          lineTotal: totalDeLinea,
          options: linea.options.map(elegida => ({
            name: elegida.name,
            groupName: porGrupo.get(elegida.groupId)?.name || '',
            quantity: elegida.quantity,
            price: 0,
          })),
        })
      }
      continue
    }

    // Los topes del grupo se exigen aquí también: cotizar algo que la RPC va a
    // rechazar dejaría al cliente pagando una pantalla que no existe.
    //
    // ⚠️ Los DOS, mínimo y máximo, y con las mismas cuentas que la RPC. Hasta
    // el 2026-08-09 solo se comprobaba el mínimo: una pizza con tres sabores
    // teniendo el tope en dos se cotizaba sin queja, con su precio y todo, y
    // reventaba al confirmar con «Demasiadas opciones». La app bloquea al
    // llegar al máximo, pero la app no es la defensa — este endpoint se llama
    // igual sin pasar por ella.
    for (const grupo of input.optionGroups) {
      const aplica = grupo.product_id === producto.id
        || (Boolean(grupo.category_id) && grupo.category_id === producto.category_id)
      if (!aplica) continue
      const elegidas = elegidasPorGrupo.get(grupo.id) || []
      // En los contadores cuentan las PORCIONES; en el resto, cuántas se
      // marcaron. Una parrillada de 4 se cumple con un corte pedido 4 veces.
      const cuenta = grupo.selection_type === 'quantity'
        ? elegidas.reduce((suma, opcion) => suma + opcion.quantity, 0)
        : elegidas.length
      const minimo = Math.max(grupo.required ? 1 : 0, grupo.min_selectable ?? 0)
      if (cuenta < minimo) return vacia(`Falta elegir ${grupo.name} en ${producto.name}`)
      // Mismo texto que la RPC a propósito: el cliente lee lo mismo venga el
      // rechazo de donde venga.
      const maximo = Math.max(1, grupo.max_selectable ?? 1)
      if (cuenta > maximo) return vacia(`Demasiadas opciones en ${grupo.name}`)
    }

    const unitPrice = calculateProductPrice({
      basePrice: base,
      groups: [...elegidasPorGrupo.entries()].map(([groupId, selections]) => ({
        strategy: (porGrupo.get(groupId)?.pricing_strategy || 'sum') as PricingStrategy,
        freeSelections: porGrupo.get(groupId)?.free_selections ?? 0,
        selections,
      })),
    })
    if (!(unitPrice > 0)) return vacia(`${producto.name} quedaría sin precio válido`)

    const lineTotal = Math.round(unitPrice * cantidad * 100) / 100
    subtotal += lineTotal
    lines.push({
      productId: producto.id,
      name: producto.name,
      quantity: cantidad,
      unitPrice,
      lineTotal,
      options: detalle,
    })
  }

  // Quien retira en el local no paga envío, igual que en la RPC.
  const shipping = input.fulfillment === 'delivery'
    ? Math.max(0, Math.round(input.deliveryFee * 100) / 100)
    : 0
  subtotal = Math.round(subtotal * 100) / 100

  // ── El margen se redondea DONDE se redondea al mostrarlo ────────────
  //
  // ⚠️ Aquí decía «un solo redondeo, sobre el subtotal completo y NUNCA por
  // línea», y era exactamente lo contrario de lo que sella la base. La base lo
  // calcula por línea (`order_markup_by_line`) siempre que el modo sea
  // `on_top` con `percentage`, y su comentario explica por qué: con `on_top`
  // el cliente ve un precio POR PRODUCTO, así que el total tiene que ser lo
  // que él sumaría. Este archivo se quedó con la regla anterior.
  //
  // El resultado, medido en producción con 3 × $0.75:
  //
  //   catálogo enseña  $0.83 × 3 = $2.49
  //   la cotización     $2.48   ← la única que discrepaba
  //   el pedido cobra   $2.49
  //
  // ⚠️ Se replica la aritmética EXACTA de `order_markup_by_line`: redondear el
  // margen del precio unitario y multiplicar por la cantidad. No es «más
  // preciso» ni «menos»: es que solo puede haber UN número, y manda el que
  // cobra la base.
  //
  // ⚠️ Solo con `on_top` + `percentage`, que es la misma condición que pone la
  // base. Con `absorbed`, `tiered` o un fijo se mantiene el cálculo sobre el
  // subtotal — ahí el cliente nunca vio un precio unitario con margen.
  //
  // ⚠️ `subtotal` es y sigue siendo lo del COMERCIO. Lo que sube con `on_top`
  // es lo que paga el cliente.
  const regla = input.pricing ?? null
  // ⚠️ EN CENTAVOS ENTEROS, y esto no es un detalle de estilo.
  //
  // PostgreSQL calcula en `numeric` —decimal exacto— y JavaScript en coma
  // flotante. `1.15 * 0.1` da `0.11499999999999999`, que redondea a 11
  // centavos; la base da 12. Con el cálculo en flotante la cotización y el
  // cobro discrepaban en los precios «feos» ($0.35, $1.15) y coincidían en los
  // redondos, que es la peor forma de fallar: parece que funciona.
  //
  // Pasando a enteros, `115 × 10 / 100 = 11.5` es exactamente representable y
  // redondea a 12, igual que la base. Sin milésimas arrastradas.
  const porLinea = regla?.markupMode === 'on_top' && regla.strategy === 'percentage'
    && regla.minAmount == null && regla.maxAmount == null
    ? lines.reduce((centavos, linea) => {
      const unitario = linea.quantity > 0 ? linea.lineTotal / linea.quantity : 0
      const unitarioEnCentavos = Math.round(unitario * 100)
      const pct = Number(regla.percentage) || 0
      const margenUnitario = Math.round((unitarioEnCentavos * pct) / 100)
      return centavos + margenUnitario * linea.quantity
    }, 0) / 100
    : null
  // ⚠️ Fuera de `on_top`+`percentage` NO se toca nada: con `absorbed` el
  // margen se le quita al dueño en vez de sumárselo al cliente, así que
  // `customerSubtotal` es el subtotal y `merchantSubtotal` lo que queda. Meter
  // ahí la suma de `on_top` le cobraría al cliente un margen que no paga.
  const margen = calculatePlatformMarkup(subtotal, regla)
  const markup = porLinea === null ? margen.markup : Math.round(porLinea * 100) / 100
  const customerSubtotal = porLinea === null
    ? margen.customerSubtotal
    : Math.round((subtotal + markup) * 100) / 100
  const merchantSubtotal = porLinea === null ? margen.merchantSubtotal : subtotal
  // La tarifa de servicio: la paga el cliente y es de Umbani, igual que en la
  // base (va DENTRO de su parte). Un carrito vacío no la paga.
  const tarifa = lines.length ? Math.max(0, Math.round((Number(input.serviceFee) || 0) * 100)) / 100 : 0
  const total = Math.round((customerSubtotal + shipping + tarifa) * 100) / 100

  return {
    lines,
    subtotal,
    shipping,
    total,
    merchantSubtotal,
    platformMarkup: Math.round((markup + tarifa) * 100) / 100,
    serviceFee: tarifa,
    customerSubtotal,
    markupPercentage: input.pricing?.strategy === 'percentage'
      ? (Number(input.pricing.percentage) || 0)
      : null,
  }
}
