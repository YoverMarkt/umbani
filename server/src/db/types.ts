// Formas de los datos que devuelve la capa `db`.
//
// Viven aquí y no en cada repositorio por una razón muy concreta: los
// repositorios usan `export =` (interoperabilidad con CommonJS) y eso no admite
// `export interface` al lado. Sin un sitio donde nombrarlos, TypeScript no
// puede inferir el tipo del compositor `db/index.ts` — y ahí empezaba el
// problema que obligaba a cada consumidor a AFIRMAR su interfaz con `as`,
// que el compilador no comprueba (ver PR del 2026-08-02).

/**
 * Una fila real de `businesses`, columna por columna.
 *
 * Antes esto era `Record<string, unknown>` —una bolsa suelta— y por eso NADIE
 * podía comprobar nada: cada archivo declaraba su propia interfaz estrecha y la
 * afirmaba con `as`, que el compilador se cree sin mirar. Así se coló en
 * producción un `issueLink` que no existía (2026-08-02).
 *
 * Las columnas salen del esquema real (`npm run verify:drift` las compara).
 * Lo opcional es opcional aquí porque lo es en la base: si escribes
 * `business.ycloud_api_key` sin comprobarlo, TypeScript ahora te lo dice.
 */
export interface BusinessRecord {
  id: string
  slug: string
  name: string
  /** Local de demostración: su dinero es de prueba (2026-09-30). */
  is_demo?: boolean | null
  type?: string | null
  description?: string | null
  hours?: string | null
  address?: string | null
  phone?: string | null
  social?: string | null
  payment_methods?: string | null
  whatsapp_number?: string | null
  whatsapp_provider?: string | null
  meta_token?: string | null
  meta_phone_id?: string | null
  ycloud_api_key?: string | null
  ycloud_number?: string | null
  ycloud_webhook_endpoint_id?: string | null
  ycloud_webhook_secret?: string | null
  telegram_bot_token?: string | null
  calcom_link?: string | null
  ai_provider?: string | null
  slogan?: string | null
  // Mini app: costo fijo de envío a domicilio, color e imagen del negocio.
  delivery_fee?: number | string | null
  brand_color?: string | null
  logo_url?: string | null
  /** Imagen de portada de la mini app. Solo https, igual que el logo. */
  cover_url?: string | null
  // Cuánto tarda en tener el pedido listo y cuánto suma llevarlo. El primero
  // manda además en las franjas programables; el segundo solo se muestra.
  prep_time_minutes?: number | string | null
  delivery_extra_minutes?: number | string | null
  /** 0 = sin mínimo. Lo pone el dueño según su producto más barato. */
  min_order_amount?: number | string | null
  /** Cuántos pedidos de la tienda acepta por hora. Protege su cocina. */
  max_orders_per_hour?: number | string | null
  payment_window_minutes?: number | string | null
  owner_phone?: string | null
  /** Si el dueño recibe el pedido por WhatsApp. Nace APAGADO: cuesta mensajes. */
  notify_owner_whatsapp?: boolean | null
  /** El punto del local en el mapa. Las dos o ninguna (`businesses_ubicacion_check`). */
  latitude?: number | string | null
  longitude?: number | string | null
  notes?: string | null
  plan?: string | null
  // Nota: la columna de vencimiento del plan existe en la base pero el
  // producto NO la usa; se retiró junto con los cobros automáticos y un
  // guardián de tests impide que vuelva a aparecer en el código.
  monthly_rate?: number | null
  monthly_contact_limit?: number | null
  monthly_outbound_message_limit?: number | null
  active?: boolean | null
  bot_active?: boolean | null
  suspended?: boolean | null
  suspension_reason?: string | null
  created_at?: string | null
  // Capacidades: fuente de verdad de qué sabe hacer el negocio.
  takes_orders: boolean
  storefront_enabled: boolean
  chat_mode: string
}

/**
 * Lo que devuelve una escritura de Supabase: o hay dato y no hay error, o al
 * revés. Nunca las dos cosas.
 *
 * Es una UNIÓN y no `{ data: T | null; error: E | null }` a propósito: así, a
 * quien ya escribe `if (error) return …` le basta esa línea para que TypeScript
 * sepa que `data` dejó de ser nulo. Con el objeto suelto haría falta una
 * segunda comprobación que el código no necesita y que nadie escribiría.
 */
export type WriteResult<T> =
  | { data: T; error: null }
  | { data: null; error: { message: string } }

/**
 * Una consulta de producto con el nombre del producto incrustado.
 *
 * `products` es UN objeto, no una lista: la consulta va de muchos a uno
 * (`product_consultations.product_id` → `products`) y PostgREST devuelve el
 * registro suelto. Se anota a mano porque, sin los tipos generados de la base,
 * el SDK supone lista para cualquier relación incrustada y se equivoca.
 */
export interface ConsultationRow {
  product_id?: string | null
  products?: { name?: string | null } | null
}

export interface PendingSession {
  contact_phone?: string | null
  last_message_at?: string | null
}

export interface PlatformErrorRow {
  id: string
  business_id: string | null
  category: string
  code: string | null
  message: string
  context: Record<string, unknown>
  occurrences: number
  first_seen_at: string
  last_seen_at: string
}

type ScheduleData = Record<string, unknown>

export interface ScheduleRecord extends ScheduleData {
  day_of_week: number
  open_time: string
  close_time: string
  /** Ese día se atiende entero; manda sobre open_time/close_time. */
  is_24h?: boolean | null
  slot_duration?: number | null
  is_active?: boolean | null
}

export interface TagData {
  name: string
  color?: unknown
}

/**
 * Plantilla de arranque de un tipo de negocio: las categorías con las que nace
 * su catálogo, las listas que se repiten y UN producto de ejemplo armado como
 * se arma de verdad en ese tipo.
 *
 * Un grupo puede colgar de la CATEGORÍA (lo heredan todos sus productos) o de
 * un producto de ejemplo. Los importes van en `recargo` y admiten negativos
 * («sin huevos −0.50» en los desayunos).
 */
export interface TemplateOption {
  nombre: string
  recargo?: number
  orden?: number
}

export interface TemplateGroup {
  nombre: string
  descripcion?: string
  tipo?: 'single' | 'multiple' | 'quantity'
  obligatorio?: boolean
  min?: number
  max?: number
  orden?: number
  /** `pricing_strategy`. Sin él, `sum`: cada opción suma su recargo. */
  cobro?: 'sum' | 'included' | 'highest_selected'
  /** Parte del plato por partes. Solo en un producto y contada por porciones. */
  parte?: boolean
  /** Lo que cuesta una porción de la parte que no completa un plato. */
  precioSuelto?: number
  /** Nombre de una lista de `BusinessTemplate.listas`: la base pone las opciones. */
  lista?: string
  opciones?: TemplateOption[]
}

/**
 * Un producto de EJEMPLO. Nace AGOTADO siempre —lo impone la base, no esto—
 * porque su precio es inventado. No oculto: aquí inactivo es borrado.
 */
export interface TemplateProduct {
  nombre: string
  precio: number
  descripcion?: string
  tipo?: 'simple' | 'configurable' | 'combo' | 'daily_menu'
  orden?: number
  grupos?: TemplateGroup[]
}

/** Una lista reutilizable (`option_templates`): los sabores de una pizzería. */
export interface TemplateList {
  nombre: string
  descripcion?: string
  opciones: TemplateOption[]
}

export interface TemplateCategory {
  nombre: string
  orden?: number
  grupos?: TemplateGroup[]
  productos?: TemplateProduct[]
}

export interface BusinessTemplate {
  listas?: TemplateList[]
  categorias: TemplateCategory[]
}

/**
 * La carta de un local, leída de su foto y REVISADA por una persona. Es una
 * plantilla con dos diferencias que aplica `apply_business_menu`: sus precios
 * son de verdad (los productos nacen a la venta) y trae tamaños.
 */
export interface MenuVariant {
  nombre: string
  precio: number
  orden?: number
}

export interface MenuProduct extends TemplateProduct {
  /** «Personal $5.99 · mediana $11.99»: van a `product_variants`. */
  variantes?: MenuVariant[]
}

export interface MenuCategory extends Omit<TemplateCategory, 'productos'> {
  productos?: MenuProduct[]
}

export interface BusinessMenu {
  categorias: MenuCategory[]
}

// Las columnas viajan en una cadena unida, así que el SDK no puede deducirlas y
// devuelve un tipo de error en vez de la fila. La conversión vive AQUÍ, en el
// borde con el driver, y no repartida por quien consume — que fue el agujero de
// los 115 casts del 2026-08-03.
export interface OptionGroupRow {
  id: string
  product_id: string | null
  category_id: string | null
  name: string
  description: string | null
  selection_type: string
  required: boolean
  min_selectable: number
  max_selectable: number
  max_total_quantity: number | null
  pricing_strategy: string
  free_selections: number
  option_template_id: string | null
  sort: number
  active: boolean
  /** Parte del plato por partes: una porción de cada parte forma un plato. */
  is_meal_part: boolean
  /** Lo que cuesta una porción suelta de esta parte. Nulo: no se vende sola. */
  loose_price: string | number | null
}

export interface OptionRow {
  id: string
  option_group_id: string
  name: string
  description: string | null
  image_url: string | null
  image_public_id: string | null
  price_adjustment: string | number
  references_product_id: string | null
  default_selected: boolean
  stock: string
  sort: number
  active: boolean
  /**
   * Si no es nulo, la opción es una COPIA de un ítem de plantilla que mantiene
   * la base (`sincronizar_plantilla_en_grupo`, 2026-09-16). No se edita suelta.
   */
  option_template_item_id: string | null
}

export interface OptionTemplateRow {
  id: string
  name: string
  description: string | null
  active: boolean
}

export interface OptionTemplateItemRow extends Omit<OptionRow, 'option_group_id'> {
  option_template_id: string
}

/** Qué se ofrece «además», y desde dónde. Ambos orígenes nulos = del negocio. */
export interface RecommendationRow {
  id: string
  source_product_id: string | null
  source_category_id: string | null
  recommended_product_id: string
  section: string
  sort: number
  active: boolean
}

/**
 * Una regla de margen ya saneada por la ruta, lista para guardar.
 *
 * Vive aquí y no en su repositorio por el motivo de la cabecera: `export =`
 * no admite `export interface` al lado, y sin poder nombrar el tipo, el
 * compositor `db/index.ts` no puede inferir el suyo.
 */
export interface PricingRuleInput {
  scope: string
  strategy: string
  markup_mode?: string
  business_id?: string | null
  target_name?: string | null
  percentage?: number | null
  fixed_amount?: number | null
  tiers?: Array<{ up_to: number | null, amount: number }> | null
  min_amount?: number | null
  max_amount?: number | null
  notes?: string | null
}
