import type {
  CartLine,
  ChosenOption,
  Extra,
  Fulfillment,
  OptionGroup,
  PricingStrategy,
  Product,
  Variant,
} from './types'

// Carrito.
//
// ⚠️ Los importes de aquí son PARA PINTAR. El total que se cobra lo calcula el
// servidor contra su propio catálogo (regla inviolable #8): la app solo manda
// ids y cantidades. Si algún día no coinciden, manda el servidor y hay que
// arreglar el catálogo, no este archivo.

/**
 * Identidad de una línea. Dos "pizzas grandes" con extras distintos son dos
 * líneas; dos idénticas se suman en cantidad, como espera cualquiera.
 */
export const lineKey = (
  product: Product,
  variant: Variant | null,
  extras: Extra[],
  note: string,
  options: ChosenOption[] = [],
): string => [
  product.id,
  variant?.id || '',
  extras.map(extra => extra.id).sort().join(','),
  // La cantidad entra en la identidad: dos parrilladas con los mismos cortes
  // pero repartidos distinto («2 lomo + 1 pollo» vs «1 lomo + 2 pollo») son dos
  // platos distintos, y sumarlas en una sola línea perdería lo que se pidió.
  options.map(opcion => `${opcion.optionId}x${opcion.quantity}`).sort().join(','),
  note.trim().toLowerCase(),
].join('|')

/**
 * Lo que suma UN grupo, según cómo lo cobre el negocio.
 *
 * Es la copia en el teléfono de `server/src/services/pricing.ts`, y existe por
 * un motivo concreto: sin ella, media Suprema ($10) y media Hawaiana ($9) se
 * pintarían como $19 —el doble de una pizza— y al confirmar el pedido el
 * cliente vería $10. Enterarse del precio real al final es la peor forma de
 * enterarse.
 *
 * Las dos reglas que no son obvias, iguales que en la base:
 *   · `highest_selected` mira el precio UNITARIO: dos medias pizzas son una.
 *   · las estrategias con límite descuentan las MÁS CARAS, nunca por orden de
 *     clic, o el mismo carrito costaría distinto según cómo se armara.
 */
export function groupPrice(
  strategy: PricingStrategy,
  freeSelections: number,
  options: ChosenOption[],
): number {
  const elegidas = options.filter(opcion => (opcion.quantity || 1) > 0)
  if (!elegidas.length) return 0
  const centavos = (valor: number) => Math.round(valor * 100) / 100
  const precios = elegidas.map(opcion => opcion.price || 0)

  if (strategy === 'fixed' || strategy === 'included') return 0
  if (strategy === 'highest_selected') return centavos(Math.max(...precios))
  if (strategy === 'lowest_selected') return centavos(Math.min(...precios))
  if (strategy === 'average') {
    return centavos(precios.reduce((t, p) => t + p, 0) / precios.length)
  }

  if (strategy === 'included_up_to_limit' || strategy === 'extra_after_limit') {
    if (freeSelections <= 0) {
      return centavos(elegidas.reduce((t, o) => t + (o.price || 0) * (o.quantity || 1), 0))
    }
    const ordenadas = [...elegidas].sort((a, b) => (b.price || 0) - (a.price || 0))
    if (strategy === 'included_up_to_limit') {
      return centavos(ordenadas
        .slice(freeSelections)
        .reduce((t, o) => t + (o.price || 0) * (o.quantity || 1), 0))
    }
    // Por porciones: una opción puede quedar a medias.
    let restantes = freeSelections
    let total = 0
    for (const opcion of ordenadas) {
      const cantidad = opcion.quantity || 1
      const gratis = Math.min(restantes, cantidad)
      restantes -= gratis
      total += (opcion.price || 0) * (cantidad - gratis)
    }
    return centavos(total)
  }

  return centavos(elegidas.reduce((t, o) => t + (o.price || 0) * (o.quantity || 1), 0))
}

/**
 * Precio unitario mostrado: base (o variante), más los extras, más lo que
 * aporte cada grupo con SU estrategia. Los recargos pueden ser NEGATIVOS
 * —«sin sopa −0.50»—, así que el resultado se protege de bajar de cero: un
 * plato gratis por acumular descuentos sería un agujero, y el servidor lo
 * rechazaría igual.
 */
export const unitPrice = (
  product: Product,
  variant: Variant | null,
  extras: Extra[],
  options: ChosenOption[] = [],
): number => {
  const base = variant
    ? (variant.priceSale ?? variant.price)
    : (product.priceFrom ?? 0)
  const suma = extras.reduce((total, extra) => total + (extra.price || 0), 0)

  // Cada grupo con lo suyo: sumarlo todo a bulto sería el error de la mitad y
  // mitad. Un grupo que ya no está en el catálogo se cobra como `sum`, que es
  // lo que hacía antes.
  const porGrupo = new Map<string, ChosenOption[]>()
  for (const opcion of options) {
    porGrupo.set(opcion.groupId, [...porGrupo.get(opcion.groupId) || [], opcion])
  }
  let opciones = 0
  for (const [groupId, elegidas] of porGrupo) {
    const grupo = product.optionGroups.find(g => g.id === groupId)
    opciones += groupPrice(
      grupo?.pricingStrategy || 'sum',
      grupo?.freeSelections || 0,
      elegidas,
    )
  }

  return Math.max(0, Math.round((base + suma + opciones) * 100) / 100)
}

/**
 * ¿Se puede agregar ya, o falta algo obligatorio?
 *
 * Devuelve el PRIMER grupo que falta, con el texto que va en el botón. Decir
 * «Elige el término» lleva al cliente al sitio; «Completa las opciones» lo deja
 * buscando cuál de seis bloques es.
 *
 * Es la mitad visible de la regla: la otra la aplica la base al crear el pedido,
 * que es la que de verdad manda.
 */
export function missingRequirement(
  groups: OptionGroup[],
  options: ChosenOption[],
): { group: OptionGroup; message: string } | null {
  for (const group of groups) {
    if (!group.required && group.minSelectable <= 0) continue

    const elegidas = options.filter(opcion => opcion.groupId === group.id)
    // En los contadores lo que cuenta son las porciones, no cuántas casillas
    // se tocaron: una parrillada de 4 se cumple con un solo corte por 4.
    const total = group.selectionType === 'quantity'
      ? elegidas.reduce((suma, opcion) => suma + opcion.quantity, 0)
      : elegidas.length

    const minimo = Math.max(group.required ? 1 : 0, group.minSelectable)
    if (total >= minimo) continue

    return {
      group,
      message: minimo > 1
        ? `Elige ${minimo} en ${group.name}`
        : `Elige ${group.name.toLowerCase()}`,
    }
  }
  return null
}

/**
 * ¿Este grupo admite UNA sola opción?
 *
 * No basta con mirar `selectionType`. Un grupo guardado como `multiple` con
 * `maxSelectable: 1` es funcionalmente una elección única —la base solo deja
 * elegir una—, pero se pintaba con casillas: el cliente veía checkboxes,
 * marcaba uno y no entendía por qué no podía marcar otro. Pasó de verdad con
 * los 19 sabores de pizza.
 *
 * Se decide aquí, y no en el componente, para que la FORMA del control y el
 * COMPORTAMIENTO al tocarlo salgan de la misma respuesta. Separarlos daba un
 * radio que se podía desmarcar, o una casilla que sustituía a la anterior.
 */
export const singleChoice = (group: OptionGroup): boolean =>
  group.selectionType === 'single'
  || (group.selectionType === 'multiple' && group.maxSelectable === 1)

/**
 * ¿Este grupo se pinta como píldoras en fila, en vez de lista vertical?
 *
 * «Masa: Tradicional · Delgada · Pan Pizza» ocupa una línea y se entiende de
 * un vistazo; en lista vertical gasta tres filas para decir lo mismo.
 *
 * Los topes NO son estéticos, evitan que se rompa:
 *   · Elección única — varias marcadas en fila no se distinguen bien.
 *   · Hasta 4 opciones — con 19 sabores la fila se vuelve ilegible.
 *   · Nombres cortos — «Pizza cuatro quesos artesanal» no cabe en una píldora.
 *   · Sin foto ni descripción — una píldora no tiene dónde ponerlas, y en un
 *     combo la foto es justo lo que ayuda a elegir.
 *   · Nada INCLUIDO — la píldora no tiene sitio para la palabra «Incluida», y
 *     esa palabra es lo que le dice al cliente que ya la pagó. Sin ella, la
 *     bebida del combo parece una opción más que quizá cobren. Se vio al
 *     probarlo: el grupo entraba en píldoras y la palabra desaparecía.
 */
export const pillLayout = (group: OptionGroup): boolean =>
  singleChoice(group)
  && group.options.length > 0
  && group.options.length <= 4
  && group.pricingStrategy !== 'included'
  && group.pricingStrategy !== 'included_up_to_limit'
  && group.options.every(opcion =>
    opcion.name.length <= 14 && !opcion.imageUrl && !opcion.description)

/**
 * Qué se escribe donde iría el precio de una opción.
 *
 * En un combo la bebida VIENE con el plato, y poner «$0.00» ahí se lee como un
 * error de precio en vez de como algo que ya pagaste. La palabra «Incluida» lo
 * dice sin ambigüedad, y las mejoras del mismo grupo siguen con su recargo:
 * «Pepsi 1L · Incluida» junto a «Pepsi 2L · +$1.50».
 *
 * La señal es la ESTRATEGIA del grupo, no el precio a secas: en un grupo normal
 * un «Sin borde» a cero sí debe verse como `$0.00`, porque no viene incluido en
 * nada — simplemente no añade.
 *
 * Devuelve null cuando no hay nada que escribir.
 */
export const optionPriceLabel = (
  group: OptionGroup,
  price: number,
): { incluida: true } | { incluida: false; amount: number } | null => {
  if (price !== 0) return { incluida: false, amount: price }
  const vieneIncluido = group.pricingStrategy === 'included'
    || group.pricingStrategy === 'included_up_to_limit'
  return vieneIncluido ? { incluida: true } : null
}

/** Cuánto se lleva elegido de un grupo, contando porciones en los contadores. */
export function chosenCount(group: OptionGroup, options: ChosenOption[]): number {
  const elegidas = options.filter(opcion => opcion.groupId === group.id)
  return group.selectionType === 'quantity'
    ? elegidas.reduce((suma, opcion) => suma + opcion.quantity, 0)
    : elegidas.length
}

export const lineTotal = (line: CartLine): number =>
  Math.round(line.unitPrice * line.quantity * 100) / 100

export const cartTotal = (lines: CartLine[]): number =>
  Math.round(lines.reduce((total, line) => total + lineTotal(line), 0) * 100) / 100

/**
 * Cuántos platos lleva el carrito.
 *
 * ⚠️ La mesa de un plato por partes es UNA línea con cantidad 1, pero puede
 * llevar diez almuerzos: contar la línea le diría «1» a una familia entera.
 */
export const cartCount = (lines: CartLine[]): number =>
  lines.reduce((total, line) => total + (esPlatoPorPartes(line.product)
    ? platosDeLaMesa(line)
    : line.quantity), 0)

/**
 * Agrega respetando la identidad de la línea. Devuelve un carrito nuevo.
 *
 * ⚠️ La mesa de un plato por partes SUSTITUYE a la anterior, no se suma: la
 * ficha se abre con lo que ya lleva y el cliente la edita entera. Sumarla
 * pondría la cantidad en 2, y la base rechaza la mesa con cualquier cantidad
 * que no sea 1.
 */
export function addLine(lines: CartLine[], nueva: CartLine): CartLine[] {
  const existente = lines.find(line => line.key === nueva.key)
  if (!existente) return [...lines, nueva]
  if (esPlatoPorPartes(nueva.product)) {
    return lines.map(line => (line.key === nueva.key ? nueva : line))
  }
  return lines.map(line => line.key === nueva.key
    ? { ...line, quantity: Math.min(99, line.quantity + nueva.quantity) }
    : line)
}

/**
 * La línea SUELTA de un producto: sin variante, sin extras, sin opciones y sin
 * nota. Es la que crea el `+` de un adicional.
 *
 * ⚠️ Vive aquí, y no en la pantalla, por el mismo motivo que `ENTREGA_POR_DEFECTO`:
 * la usan la portada y la ficha, y dos copias se desincronizan.
 */
export const claveSuelta = (product: Product): string =>
  lineKey(product, null, [], '', [])

/**
 * Lo que costará tocar «Agregar»: el plato por su cantidad, más lo que se haya
 * marcado para acompañarlo.
 *
 * ⚠️ En CENTAVOS ENTEROS, como todo el dinero de esta app. Sumar dólares en
 * coma flotante y redondear al final da un céntimo de diferencia con lo que
 * cobra la base (`create_storefront_order`), y ese céntimo lo ve el cliente.
 *
 * ⚠️ Vive aquí y no en el componente porque es un número que el cliente LEE
 * antes de decidir. La regla de la casa es que el dinero se calcula donde se
 * puede comprobar; en el JSX no se puede.
 */
export const totalAAgregar = (
  precioDelPlato: number,
  cantidad: number,
  acompanantes: { price: number; quantity: number }[],
): number => {
  const centavos = Math.round(precioDelPlato * 100) * Math.max(0, cantidad)
  const extra = acompanantes.reduce(
    (suma, item) => suma + Math.round((item.price || 0) * 100) * Math.max(0, item.quantity || 0),
    0,
  )
  return Math.max(0, centavos + extra) / 100
}

/**
 * ¿Hay que ARMAR este producto antes de meterlo al carrito?
 *
 * Un producto con variantes, con un grupo obligatorio o que se pide por partes
 * no entra de un toque: la base lo rechazaría, así que se le abre su ficha.
 *
 * ⚠️ Una sola definición para las dos pantallas. La portada la usa para decidir
 * si abre la ficha, y la ficha para decidir si el adicional se puede contar en
 * su propio pie o hay que mandarlo a armar. Si divergieran, el pie sumaría un
 * producto que el carrito nunca recibió.
 */
export const seArma = (product: Product): boolean =>
  product.hasVariants
  || esPlatoPorPartes(product)
  || product.optionGroups.some(grupo => grupo.required || grupo.minSelectable > 0)

/** Cambia la cantidad; en cero la línea desaparece. */
export function setQuantity(lines: CartLine[], key: string, quantity: number): CartLine[] {
  if (quantity <= 0) return lines.filter(line => line.key !== key)
  return lines.map(line => line.key === key ? { ...line, quantity } : line)
}

// ── Cómo lo recibe ─────────────────────────────────────────────────────────
//
// Se elige en DOS pantallas —la portada y el carrito— y decide dos cosas que
// el cliente ve: cuánto paga y qué datos le pedimos. Vive aquí, fuera de los
// componentes, para que las dos pantallas cuenten lo mismo y para que se pueda
// comprobar de verdad: cuando esto vivía dentro del carrito, elegir «Retiro»
// arriba y abrir el carrito lo devolvía a «Entrega» sin avisar.

/** A domicilio, que es lo que quiere casi todo el mundo. */
export const ENTREGA_POR_DEFECTO: Fulfillment = 'delivery'

/** Solo a domicilio hace falta saber a dónde. En retiro no se piden datos. */
export const needsAddress = (fulfillment: Fulfillment): boolean =>
  fulfillment === 'delivery'

/**
 * El total que se PINTA, con el envío incluido solo si se lo llevan a casa.
 *
 * Quien retira en el local no paga envío, y cobrárselo en la pantalla —aunque
 * el servidor luego no lo cobre— es prometer un número y cumplir otro. El
 * importe que manda sigue siendo el que devuelve la base al crear el pedido.
 */
export const orderTotal = (
  lines: CartLine[],
  fulfillment: Fulfillment,
  deliveryFee: number,
  /** La tarifa de servicio: la cobra la base igual, aquí solo se anticipa. */
  serviceFee = 0,
): number => {
  // ⚠️ Un carrito VACÍO no paga envío. Sin esta salida el total de un carrito
  // sin nada era el precio del envío —«Total $2.00» sobre cero productos—, y
  // eso se hizo visible el 2026-08-26 al arreglar el botón «Carrito», que
  // hasta entonces no abría nada con el carrito vacío: el fallo llevaba ahí
  // desde siempre, escondido detrás de un botón que no respondía.
  //
  // Es solo lo que se PINTA: el importe que se cobra lo calcula el servidor,
  // y allí un pedido sin líneas no existe. Pero el cliente no tiene por qué
  // ver un cobro que nadie va a hacerle.
  if (!lines.length) return 0
  const envio = needsAddress(fulfillment) ? Math.max(0, deliveryFee || 0) : 0
  return Math.round((cartTotal(lines) + envio + Math.max(0, serviceFee || 0)) * 100) / 100
}

/** Agrupa los extras por su título para pintarlos en bloques. */
export function groupExtras(extras: Extra[]): { group: string; items: Extra[] }[] {
  const grupos = new Map<string, Extra[]>()
  for (const extra of extras) {
    const clave = extra.group || 'Extras'
    grupos.set(clave, [...grupos.get(clave) || [], extra])
  }
  return [...grupos.entries()].map(([group, items]) => ({ group, items }))
}

/**
 * Lo que el cliente eligió, agrupado para PINTARLO en el carrito.
 *
 * ⚠️ Replica a propósito `services/order-detail.ts` del servidor, igual que
 * `groupPrice` replica `services/pricing.ts`. Aquí no hay servidor al que
 * preguntar: el carrito todavía no es un pedido, existe solo en este teléfono.
 * Las reglas son las mismas —grupos y opciones en orden alfabético, el x1 no se
 * dice— para que el carrito y la pantalla de seguimiento cuenten el MISMO plato
 * de la misma forma. Si divergen, el cliente cree que pidió otra cosa.
 */
export function groupChosen(
  options: ChosenOption[],
  groups: OptionGroup[] = [],
): { group: string; items: { name: string; quantity: number }[] }[] {
  const grupos = new Map<string, { name: string; quantity: number }[]>()
  for (const opcion of options) {
    const grupo = (opcion.groupName || '').trim()
    const nombre = (opcion.name || '').trim()
    // Sin grupo o sin nombre no se puede contar nada: pintar «: algo» sería
    // peor que callarlo.
    if (!grupo || !nombre) continue
    const cantidad = Math.max(1, Math.trunc(opcion.quantity || 1))
    grupos.set(grupo, [...grupos.get(grupo) || [], { name: nombre, quantity: cantidad }])
  }

  // ⚠️ El orden es el que puso EL DUEÑO, que aquí sale gratis: `groups` viene
  // del catálogo ya ordenado por su `sort`, y es el MISMO orden en que el
  // cliente acaba de armar el plato en la ficha. Ordenarlo distinto en el
  // carrito le haría releer de arriba abajo para comprobar lo que eligió.
  // El alfabético queda de desempate, para los grupos que ya no están en el
  // catálogo y para los que el dueño nunca ordenó.
  const posicion = new Map(groups.map((grupo, indice) => [grupo.name, indice]))
  const puesto = (nombre: string) => posicion.get(nombre) ?? Number.MAX_SAFE_INTEGER

  return [...grupos.entries()]
    .sort(([a], [b]) => puesto(a) - puesto(b) || a.localeCompare(b, 'es'))
    .map(([group, items]) => ({
      group,
      items: [...items].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    }))
}

/** Una línea de texto por grupo: «Sabor: Criolla, Monster». */
export const chosenLines = (
  options: ChosenOption[],
  groups: OptionGroup[] = [],
): string[] =>
  groupChosen(options, groups).map(grupo => `${grupo.group}: ${grupo.items
    .map(item => (item.quantity > 1 ? `${item.name} x${item.quantity}` : item.name))
    .join(', ')}`)

/**
 * Qué dice cada línea del carrito además de su nombre.
 *
 * Si el cliente eligió algo, eso manda: en una pizza, «Sabor: Criolla» dice
 * mucho más que «Elige tamaño y sabor», que es la descripción del catálogo y a
 * estas alturas ya no sirve de nada — ya eligió.
 *
 * ⚠️ Si NO eligió nada, va la descripción del producto, y ahí es donde hace
 * falta de verdad: en un combo la descripción ES el contenido. «Burger Pack
 * $10.99» no le dice a nadie que son dos hamburguesas dobles, una salchipapa y
 * una cola de 1.35 litros. Sin esto el cliente confirma sin saber qué compra.
 *
 * Nunca las dos cosas: la línea del carrito es un resumen, no una ficha.
 */
export const detalleDeLinea = (linea: CartLine): string[] => {
  // ⚠️ La mesa de un plato por partes se cuenta por sus PLATOS, como la va a
  // guardar la base: «2 × Almuerzo · Sopa: Caldo x2», «1 × Solo segundo:
  // Ceviche». Una lista suelta de sopas y segundos no le dice a la familia
  // cuántos almuerzos está pagando.
  if (esPlatoPorPartes(linea.product)) {
    const plato = lineasDelPlato(linea.product, linea.options)
    if (plato.lines) {
      return plato.lines.flatMap((parte) => {
        const cabecera = `${parte.quantity} × ${parte.name}`
        if (!parte.options.length) return [cabecera]
        // Los platos completos llevan lo elegido en RENGLONES: en una sola
        // frase el carrito la cortaba a dos líneas y se perdía qué jugo iba.
        if (parte.name === linea.product.name) {
          return [cabecera, ...chosenLines(parte.options, linea.product.optionGroups)]
        }
        return [`${cabecera}: ${parte.options
          .map(opcion => (opcion.quantity > 1 ? `${opcion.name} x${opcion.quantity}` : opcion.name))
          .join(', ')}`]
      })
    }
  }

  const elegido = chosenLines(linea.options, linea.product.optionGroups)
  if (elegido.length) return elegido
  if (linea.extras.length) return [linea.extras.map(extra => extra.name).join(' · ')]
  const descripcion = (linea.product.description || '').trim()
  return descripcion ? [descripcion] : []
}

// ═══════════════════════════════════════════════════════════════════════════
// EL PLATO POR PARTES — la mesa de una familia
// ═══════════════════════════════════════════════════════════════════════════
//
// La familia marca cuántas sopas y segundos quiere y la ficha le enseña, ANTES
// de agregar, cuántos almuerzos son y cuánto cuestan. Es la copia en el
// teléfono de `buildMealLines` (`server/src/services/pricing.ts`), que replica
// `lineas_del_plato_por_partes` de la base — la única que cobra.
//
// Las reglas, las mismas en los tres sitios:
//   · una porción de cada parte es un plato completo, al precio del dueño;
//   · lo que sobra de una parte se cobra a su precio suelto, y sin él no se vende;
//   · un acompañante con precio es su propia línea;
//   · lo gratis va con el plato y no suma.
//
// ⚠️ Aquí manda el orden de la CARTA —la posición en el catálogo—, no el
// `sort` + id de la base. Solo decide qué porción se lista como suelta, y todas
// las de una parte cuestan lo mismo: el dinero no cambia. Lo que queda guardado
// y se ve después en el pedido es lo que arma la base.

/** ¿Este producto se arma por partes? Lo dicen sus grupos, no el tipo de comida. */
export function esPlatoPorPartes(product: Product): boolean {
  return product.optionGroups.some(grupo => grupo.isMealPart === true)
}

/** La mesa de un plato va en UNA sola línea del carrito: su clave es la del producto. */
export const claveDelPlato = (product: Product): string => `${product.id}|plato`

export interface LineaDelPlato {
  name: string
  quantity: number
  /** Con el margen de la tienda, como todo precio del catálogo. */
  unitPrice: number
  options: ChosenOption[]
}

/**
 * Cuántos PLATOS lleva esta mesa: completos más partes sueltas.
 *
 * Es el tope de todo lo que va gratis. Vive aparte de `lineasDelPlato` porque
 * la ficha lo necesita MIENTRAS el cliente arma —para no dejarle marcar un
 * cuarto jugo sobre tres platos—, y ahí todavía no hay líneas que construir.
 *
 * ⚠️ Una sola cuenta para las dos: si la ficha se inventara la suya, la pantalla
 * dejaría marcar lo que el carrito rechaza después, que es peor que no topar.
 */
export function platosDeLaMesaElegida(
  product: Product,
  options: ChosenOption[],
): number {
  const partes = product.optionGroups.filter(grupo => grupo.isMealPart === true)
  if (!partes.length) return 0
  const porcionesDe = (groupId: string) => options
    .filter(opcion => opcion.groupId === groupId && opcion.quantity > 0)
    .reduce((total, opcion) => total + opcion.quantity, 0)
  const completos = Math.min(...partes.map(parte => porcionesDe(parte.id)))
  return partes.reduce(
    (total, parte) => total + Math.max(0, porcionesDe(parte.id) - completos),
    completos,
  )
}

/**
 * Lo gratis de un grupo que ACOMPAÑA a un plato por partes: cuántos platos hay
 * y cuántas opciones gratis van marcadas. Nulo si el grupo no se topa por
 * platos (no es plato por partes, es una parte, o no trae nada gratis).
 *
 * ⚠️ Cuenta OPCIÓN POR OPCIÓN, igual que `lineasDelPlato` y la base: un grupo
 * puede mezclar jugos gratis con «Sandía +$0.55», y solo los gratis se topan.
 */
export function gratisDelGrupo(
  product: Product,
  group: OptionGroup,
  options: ChosenOption[],
): { platos: number; usadas: number } | null {
  if (!esPlatoPorPartes(product) || group.isMealPart === true) return null
  const gratis = new Set(group.options.filter(opcion => opcion.price === 0).map(opcion => opcion.id))
  if (!gratis.size) return null
  return {
    platos: platosDeLaMesaElegida(product, options),
    usadas: options
      .filter(opcion => opcion.groupId === group.id && gratis.has(opcion.optionId))
      .reduce((total, opcion) => total + opcion.quantity, 0),
  }
}

/**
 * Hasta cuántas porciones puede llevar ESTA opción ahora mismo. Es lo que
 * apaga el «+» de la ficha.
 *
 * ⚠️ Existe porque la ficha topaba el GRUPO solo si todas sus opciones eran
 * gratis. En La Abuelita (2026-09-17) bastó añadir «Sandía +$0.55» a las
 * bebidas para que el contador de un jugo gratis subiera a 10 sobre un solo
 * almuerzo, mientras el carrito —que topa opción por opción— lo rechazaba.
 *
 * En un plato por partes, lo que acompaña está CERRADO hasta que haya un plato
 * (pedido del dueño: primero la sopa o el segundo, luego el jugo). Lo gratis se
 * topa en uno por plato, repartido entre sabores; lo que tiene precio, solo por
 * el máximo del grupo, porque se paga.
 */
export function topeDeLaOpcion(
  product: Product,
  group: OptionGroup,
  optionId: string,
  options: ChosenOption[],
): number {
  const delGrupo = options.filter(opcion => opcion.groupId === group.id)
  const otras = delGrupo
    .filter(opcion => opcion.optionId !== optionId)
    .reduce((total, opcion) => total + opcion.quantity, 0)
  const porElGrupo = Math.max(0, group.maxSelectable - otras)

  const esPlato = esPlatoPorPartes(product)
  if (!esPlato || group.isMealPart === true) return porElGrupo

  const platos = platosDeLaMesaElegida(product, options)
  if (platos <= 0) return 0

  const propia = group.options.find(opcion => opcion.id === optionId)
  if (!propia || propia.price !== 0) return porElGrupo

  const gratis = gratisDelGrupo(product, group, options)
  const propias = delGrupo
    .filter(opcion => opcion.optionId === optionId)
    .reduce((total, opcion) => total + opcion.quantity, 0)
  const gratisDeOtras = (gratis?.usadas ?? 0) - propias
  return Math.min(porElGrupo, Math.max(0, platos - gratisDeOtras))
}

export function lineasDelPlato(
  product: Product,
  options: ChosenOption[],
):
  | { lines: LineaDelPlato[]; platos: number; error?: undefined }
  | { lines?: undefined; platos?: undefined; error: string } {
  const grupos = product.optionGroups
  const grupoDe = new Map(grupos.map(grupo => [grupo.id, grupo]))
  const puestoDelGrupo = (id: string) => grupos.findIndex(grupo => grupo.id === id)
  const puestoDeLaOpcion = (opcion: ChosenOption) =>
    grupoDe.get(opcion.groupId)?.options.findIndex(item => item.id === opcion.optionId) ?? 0
  const elegidas = options.filter(opcion => opcion.quantity > 0)
  const porcionesDe = (groupId: string) => elegidas
    .filter(opcion => opcion.groupId === groupId)
    .reduce((total, opcion) => total + opcion.quantity, 0)
  const nombre = product.name
  const minusculas = (texto: string) => texto.toLocaleLowerCase('es')
  const fueraDeRango = { error: 'La cantidad debe estar entre 1 y 99' }

  const partes = grupos.filter(grupo => grupo.isMealPart === true)
  if (!partes.some(parte => porcionesDe(parte.id) > 0)) {
    return { error: `Elige qué quieres en ${nombre}` }
  }

  // Tantos platos completos como porciones tenga la parte MÁS CORTA.
  const completos = Math.min(...partes.map(parte => porcionesDe(parte.id)))
  if (completos > 99) return fueraDeRango

  const delCompleto: ChosenOption[] = []
  const sueltas: LineaDelPlato[] = []
  let platos = completos

  for (const parte of partes) {
    const sobran = porcionesDe(parte.id) - completos
    if (sobran > 0 && parte.loosePrice == null) {
      return { error: `En ${nombre} no se vende ${minusculas(parte.name)} por separado: completa el plato` }
    }
    if (sobran > 99) return fueraDeRango

    let paraCompletar = completos
    const deLaParte: ChosenOption[] = []
    const enOrden = elegidas
      .filter(opcion => opcion.groupId === parte.id)
      .sort((a, b) => puestoDeLaOpcion(a) - puestoDeLaOpcion(b))
    for (const eleccion of enOrden) {
      const toma = Math.min(eleccion.quantity, paraCompletar)
      paraCompletar -= toma
      if (toma > 0) delCompleto.push({ ...eleccion, quantity: toma, price: 0 })
      if (eleccion.quantity - toma > 0) {
        deLaParte.push({ ...eleccion, quantity: eleccion.quantity - toma, price: 0 })
      }
    }

    if (sobran > 0) {
      platos += sobran
      sueltas.push({
        name: `Solo ${minusculas(parte.name)}`,
        quantity: sobran,
        unitPrice: parte.loosePrice ?? 0,
        options: deLaParte,
      })
    }
  }

  // ── LO GRATIS VA POR PLATO ──────────────────────────────────────────────
  //
  // Un plato completo o una parte suelta llevan cada uno lo suyo: 2 almuerzos
  // y un segundo suelto son TRES platos, y caben tres jugos.
  //
  // ⚠️ Hasta el 2026-09-16 esto no lo contaba NADIE —ni aquí, ni `pricing.ts`,
  // ni la función de la base—, así que el único tope era `maxSelectable` del
  // grupo. En un local real valía 100: un almuerzo de $3.50 se llevaba cien
  // jugos gratis. Lo vio el dueño probando su tienda, no una prueba.
  //
  // ⚠️ Solo topa lo GRATIS. Quien quiera cinco porciones de carne las paga.
  const porGrupoGratis = new Map<string, number>()
  for (const eleccion of elegidas) {
    const grupo = grupoDe.get(eleccion.groupId)
    if (!grupo || grupo.isMealPart === true || eleccion.price !== 0) continue
    const llevadas = (porGrupoGratis.get(eleccion.groupId) || 0) + eleccion.quantity
    porGrupoGratis.set(eleccion.groupId, llevadas)
    if (llevadas > platos) {
      return {
        error: `En ${nombre}, ${minusculas(grupo.name)} va con cada plato: `
          + `llevas ${platos} y marcaste ${llevadas}`,
      }
    }
  }

  // ── Lo que acompaña: gratis con el plato, o su propia línea ─────────────
  const gratis: ChosenOption[] = []
  const conPrecio: LineaDelPlato[] = []
  const acompanantes = elegidas
    .filter(opcion => grupoDe.get(opcion.groupId)?.isMealPart !== true)
    .sort((a, b) => puestoDelGrupo(a.groupId) - puestoDelGrupo(b.groupId)
      || puestoDeLaOpcion(a) - puestoDeLaOpcion(b))
  for (const eleccion of acompanantes) {
    if (eleccion.price < 0) return { error: `${eleccion.name} tiene un precio no válido en ${nombre}` }
    if (eleccion.price === 0) {
      gratis.push(eleccion)
      continue
    }
    if (eleccion.quantity > 99) return fueraDeRango
    conPrecio.push({
      name: eleccion.name,
      quantity: eleccion.quantity,
      unitPrice: eleccion.price,
      options: [],
    })
  }

  const lineas: LineaDelPlato[] = []
  if (completos > 0) {
    lineas.push({
      name: nombre,
      quantity: completos,
      unitPrice: product.priceFrom ?? 0,
      options: [...delCompleto, ...gratis],
    })
  } else {
    // Sin plato completo, lo gratis acompaña a lo primero que se sirve suelto.
    sueltas[0]?.options.push(...gratis)
  }
  return { lines: [...lineas, ...sueltas, ...conPrecio], platos }
}

/** Lo que cuesta la mesa entera, sumado en centavos enteros como la base. */
export const totalDelPlato = (lineas: LineaDelPlato[]): number =>
  lineas.reduce((centavos, linea) => centavos + Math.round(linea.unitPrice * 100) * linea.quantity, 0) / 100

/** Cuántos platos lleva una mesa: completos y sueltos, sin contar adicionales. */
function platosDeLaMesa(line: CartLine): number {
  return lineasDelPlato(line.product, line.options).platos ?? line.quantity
}
