import type { SupabaseClient } from '@supabase/supabase-js'
import { enSegundoPlano } from '../../lib/segundo-plano'
import type { Database } from '../tipos-generados'
import type { MarketplaceBusiness } from '../../services/marketplace-menu'
import type { CategoriaEnCiudad } from '../../services/marketplace-ciudad'

// El catálogo del marketplace: qué categorías tienen locales hoy, y cuáles.
//
// ⚠️ Las dos consultas EXCLUYEN lo que no puede recibir un pedido ahora mismo
// —suspendido, inactivo, sin pedidos o sin tienda—, y lo hacen en la base y no
// aquí. Filtrar en el servidor dejaría el «(3 locales)» del menú contando
// locales cerrados.

const db: SupabaseClient<Database> = require('../client') as typeof import('../client')

/**
 * Las categorías con al menos un local disponible, UNA FILA POR CIUDAD Y
 * CATEGORÍA (2026-10-05). Nunca una vacía. De aquí salen también las ciudades
 * con locales: ver `services/marketplace-ciudad.ts`.
 */
const getMarketplaceCategories = async (): Promise<CategoriaEnCiudad[]> => {
  const { data, error } = await db.rpc('marketplace_categories_disponibles')
  if (error) throw new Error(error.message)
  return (data || []) as CategoriaEnCiudad[]
}

/**
 * Los locales de una categoría EN UNA CIUDAD, por nombre.
 *
 * ⚠️ Sin ciudad la base no devuelve ninguno (falla cerrado): enseñar los de
 * otra ciudad es el fallo que nadie notaría.
 */
const getMarketplaceBusinesses = async (
  code: string,
  cityId: string | null = null,
): Promise<MarketplaceBusiness[]> => {
  const { data, error } = await db.rpc('marketplace_negocios_de_categoria', {
    p_code: code,
    p_city_id: cityId as string,
  })
  if (error) throw new Error(error.message)
  return (data || []) as MarketplaceBusiness[]
}

/**
 * ¿Esto que escribió el cliente es COMIDA que conocemos, aunque hoy no haya
 * ningún local que la venda?
 *
 * ⚠️ Existe para no llamarle tonto a quien escribió bien. Hasta el 2026-08-25,
 * «pollo» y «asdfghjkl» recibían EXACTAMENTE el mismo «🙏 No te entendí» — y
 * «pollo» sí se entiende: el alias existe y apunta a `asados`, lo que pasa es
 * que no hay ningún asadero dado de alta. Decirle al cliente que no se le
 * entendió cuando se le entendió perfectamente es de las cosas que hacen que
 * una app parezca tonta.
 *
 * Devuelve la etiqueta de la categoría («Asados y parrilladas») o `null`.
 *
 * ⚠️ Se apoya en el diccionario de alias que ya existe, no en una lista nueva:
 * dos listas de sinónimos acabarían contradiciéndose, y esta ya la cura el
 * superadmin. El coste es que solo reconoce lo que esté en ella — «lasaña»
 * caerá en «no te entendí» hasta que alguien la añada, que es un fallo que se
 * corrige con datos y sin desplegar.
 */
/**
 * Las formas en que alguien puede escribir una misma palabra: como la tecleó,
 * en singular y en plural.
 *
 * ⚠️ NACIÓ DE UNA PRUEBA REAL (2026-09-23). El dueño escribió «Parrilladas» y
 * recibió «no lo pude entender» — aunque `parrillada → asados` SÍ está en el
 * diccionario. La consulta exigía la palabra EXACTA, así que el plural no
 * casaba.
 *
 * Y no era un caso raro: en el diccionario hay `pizza` pero no `pizzas`,
 * `almuerzo` pero no `almuerzos`, `asado` pero no `asados`. **Escribir en
 * plural fallaba siempre**, que es justo como habla la gente («quiero pizzas»,
 * «tienen almuerzos»).
 *
 * Se generan las variantes en el CÓDIGO y no en la tabla: duplicar cada
 * término a mano es una lista que se desincroniza sola, y el superadmin
 * tendría que acordarse del plural de cada cosa que añada.
 *
 * ⚠️ Solo se QUITAN o AÑADEN sufijos, nunca se inventan letras. `panes` da
 * `pane` y `pan`; `pan` da `pans` y `panes`. Alguna variante no existirá en la
 * tabla y simplemente no casará — el coste de sobrar es cero, el de faltar es
 * llamarle tonto a quien escribió bien.
 */
export const formasDeLaPalabra = (palabra: string): string[] => {
  const formas = new Set<string>([palabra])
  // Plural → singular.
  if (palabra.length > 4 && palabra.endsWith('es')) formas.add(palabra.slice(0, -2))
  if (palabra.length > 3 && palabra.endsWith('s')) formas.add(palabra.slice(0, -1))
  // Singular → plural, por si el diccionario guarda el plural («tacos»).
  if (!palabra.endsWith('s')) {
    formas.add(`${palabra}s`)
    formas.add(`${palabra}es`)
  }
  return [...formas]
}

const marketplaceKnownTerm = async (
  query: string,
): Promise<{ code: string; label: string } | null> => {
  const palabras = String(query || '')
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(palabra => palabra.length >= 3)
    .slice(0, 8)
  if (!palabras.length) return null

  // Todas las formas de todas las palabras, en UNA sola consulta: buscar por
  // variante sería multiplicar los viajes a la base por cada frase escrita.
  const terminos = [...new Set(palabras.flatMap(formasDeLaPalabra))].slice(0, 40)

  const { data, error } = await db
    .from('marketplace_search_aliases')
    .select('category_code')
    .in('term', terminos)
    .limit(1)

  let code = error || !data?.length
    ? null
    : (data[0] as { category_code?: string }).category_code || null

  // ── Segunda oportunidad: LA ERRATA ────────────────────────────────────────
  //
  // «pizzza», «hanburguesa», «almuerso». Las apps grandes no le piden al
  // cliente que escriba mejor: entienden y actúan. Solo se consulta si la
  // coincidencia exacta falló, así que quien escribe bien no paga este viaje.
  //
  // ⚠️ El umbral vive en la BASE (0.40 por defecto) y se midió, no se eligió:
  // la peor basura da 0.14 y la peor errata real 0.44. Ver la migración
  // `2026-09-23-el-chat-entiende-erratas.sql`.
  if (!code) {
    const { data: parecido } = await db.rpc('marketplace_alias_parecido', {
      p_palabras: palabras,
    })
    const fila = (parecido as { category_code?: string }[] | null)?.[0]
    code = fila?.category_code || null
  }

  if (!code) return null

  const { data: categoria } = await db
    .from('marketplace_categories')
    .select('label')
    .eq('code', code)
    .maybeSingle()
  const label = (categoria as { label?: string } | null)?.label
  // ⚠️ Se devuelve también el CÓDIGO desde el 2026-09-18: el chat enseña la
  // etiqueta, pero el registro guarda el código —«la gente pide internacional
  // y no tienes ningún local»— y eso es demanda, no un texto bonito.
  return label ? { code, label } : null
}

export interface MarketplaceHit {
  id: string
  slug: string
  name: string
  type: string
  /** Por qué salió: 'categoria' | 'producto' | 'parecido' | 'local'. */
  motivo: string
  orden: number
}

/**
 * Buscar locales en TODO el marketplace. Sin IA.
 *
 * ⚠️ Se usa solo antes de elegir local. Con local elegido el ámbito es ese
 * local y va por `searchMarketplaceProducts`: traerle la Coca Cola de otro
 * negocio metería en el carrito un producto que no puede estar ahí.
 */
const searchMarketplaceBusinesses = async (
  query: string,
  limite = 8,
  cityId: string | null = null,
): Promise<MarketplaceHit[]> => {
  // ⚠️ En la ciudad del cliente; sin ella, la base no devuelve nada.
  const { data, error } = await db.rpc('marketplace_buscar_negocios', {
    p_query: query,
    p_limite: limite,
    p_city_id: cityId as string,
  })
  if (error) throw new Error(error.message)
  return (data || []) as MarketplaceHit[]
}

export interface MarketplaceProductHit {
  id: string
  name: string
  price: number
  orden: number
}

/** Buscar DENTRO del local elegido. El filtro por negocio lo pone la base. */
const searchMarketplaceProducts = async (
  businessId: string,
  query: string,
  limite = 8,
): Promise<MarketplaceProductHit[]> => {
  const { data, error } = await db.rpc('marketplace_buscar_productos', {
    p_business_id: businessId,
    p_query: query,
    p_limite: limite,
  })
  if (error) throw new Error(error.message)
  return (data || []) as MarketplaceProductHit[]
}

/** Un cajón del menú tal como lo elige el superadmin: sin contar sus locales. */
export interface CajonDelMenu {
  code: string
  label: string
  emoji: string | null
  sort: number
}

/**
 * Los cajones del menú, TODOS los activos, tengan locales o no.
 *
 * ⚠️ Distinto de `getMarketplaceCategories`, que solo devuelve los que tienen
 * algo detrás: eso es lo que ve el cliente. Esto es para el superadmin, que
 * necesita ver el cajón vacío para poder meter ahí su primer local.
 */
const getAllMarketplaceCategories = async (): Promise<CajonDelMenu[]> => {
  const { data, error } = await db
    .from('marketplace_categories')
    .select('code,label,emoji,sort')
    .eq('active', true)
    .order('sort')
  if (error) throw new Error(error.message)
  return (data || []) as CajonDelMenu[]
}

/**
 * En qué cajones aparece un local hoy: los elegidos, o los de su tipo.
 *
 * ⚠️ Por RPC y no leyendo la vista con un anidado de PostgREST: PostgREST
 * deduce los anidados de las FOREIGN KEYS y una vista no tiene ninguna, así
 * que esa consulta fallaba SIEMPRE — y la ruta, que se tragaba el error,
 * enseñaba «sin elegir» a locales que sí tenían sus cajones puestos. Se vio
 * probando el alta real contra producción (2026-09-17).
 */
const getBusinessMarketplaceCategories = async (
  businessId: string,
): Promise<{ code: string; label: string; emoji: string | null; principal: boolean }[]> => {
  const { data, error } = await db.rpc('marketplace_cajones_del_negocio', {
    p_business_id: businessId,
  })
  if (error) throw new Error(error.message)
  return (data || []) as {
    code: string; label: string; emoji: string | null; principal: boolean
  }[]
}

/**
 * Deja los cajones de un local exactamente en esta lista. El PRIMERO es el
 * principal. Una lista vacía devuelve el local a lo que diga su tipo.
 */
const setBusinessMarketplaceCategories = async (
  businessId: string,
  codes: string[],
): Promise<number> => {
  const { data, error } = await db.rpc('set_business_marketplace_categories', {
    p_business_id: businessId,
    p_codes: codes,
    p_principal: codes[0] ?? null,
  })
  if (error) throw new Error(error.message)
  return Number(data ?? 0)
}

/**
 * Deja constancia de un paso del menú: vio los cajones, entró en uno, buscó
 * algo o eligió un local.
 *
 * ⚠️ Es un registro de PRODUCTO, no de dinero. Nunca lanza hacia arriba: si la
 * base falla, el cliente tiene que recibir su respuesta igual. Lo que se
 * pierde es una fila de un reporte, no una venta.
 *
 * El menú lo lanza sin esperar: queda en `enSegundoPlano` para que las pruebas
 * lo esperen antes de cerrar (ver lib/segundo-plano).
 */
type PasoDelMenu = {
  customerId: string | null
  tipo: 'menu' | 'cajon' | 'busqueda' | 'local'
  categoryCode?: string | null
  businessId?: string | null
  consulta?: string | null
  resultados?: number | null
}

const logMarketplaceEvent = (evento: PasoDelMenu): Promise<void> =>
  enSegundoPlano(guardarPasoDelMenu(evento))

const guardarPasoDelMenu = async (evento: PasoDelMenu): Promise<void> => {
  const { error } = await db.from('marketplace_events').insert({
    customer_id: evento.customerId,
    tipo: evento.tipo,
    category_code: evento.categoryCode ?? null,
    business_id: evento.businessId ?? null,
    // El texto ya viene normalizado del menú; aquí solo se recorta a lo que
    // admite la columna.
    consulta: evento.consulta ? String(evento.consulta).slice(0, 80) : null,
    resultados: evento.resultados ?? null,
  })
  if (error) console.error('❌ registrar el paso del menú:', error.message)
}

/**
 * Las tres preguntas del dueño sobre el menú de Umbani, de una vez: dónde se
 * cae la gente, qué cajón se abandona y qué escribe.
 *
 * ⚠️ Las tres cuentan CLIENTES, no toques: quien recorre cinco cajones es una
 * persona buscando, no cinco.
 */
const getMarketplaceUsage = async (dias = 7): Promise<{
  embudo: { paso: string; orden: number; clientes: number }[]
  cajones: { code: string; label: string; entradas: number; eligieron: number; abandonaron: number }[]
  busquedas: { consulta: string; veces: number; sin_nada: number; entendido: string | null }[]
}> => {
  const [embudo, cajones, busquedas] = await Promise.all([
    db.rpc('marketplace_embudo', { p_dias: dias }),
    db.rpc('marketplace_cajones_tocados', { p_dias: dias }),
    db.rpc('marketplace_busquedas', { p_dias: dias }),
  ])
  for (const respuesta of [embudo, cajones, busquedas]) {
    if (respuesta.error) throw new Error(respuesta.error.message)
  }
  return {
    embudo: (embudo.data || []) as { paso: string; orden: number; clientes: number }[],
    cajones: (cajones.data || []) as {
      code: string; label: string; entradas: number; eligieron: number; abandonaron: number
    }[],
    busquedas: (busquedas.data || []) as {
      consulta: string; veces: number; sin_nada: number; entendido: string | null
    }[],
  }
}

export {
  getMarketplaceCategories,
  getMarketplaceBusinesses,
  searchMarketplaceBusinesses,
  searchMarketplaceProducts,
  marketplaceKnownTerm,
  getAllMarketplaceCategories,
  logMarketplaceEvent,
  getMarketplaceUsage,
  getBusinessMarketplaceCategories,
  setBusinessMarketplaceCategories,
}
