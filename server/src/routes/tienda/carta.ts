// La tienda (mini app): la carta, quién es el cliente y sus direcciones.
// Una sección del router de `storefront.routes.ts`, que las registra EN ORDEN.

import type { Router } from 'express'
import { readStorefrontSession, requireStorefrontSession } from '../../middleware/storefront'
import { getPlatformPhone } from '../../services/platform-channel'
import { buildStorefrontCatalog, canOrder, reglaDeMargen, publicBusiness } from '../../services/storefront'
import { tarifaDeServicio } from '../../services/tarifa-de-servicio'
import { db, metodosDeLaTienda, readStatus } from './comun'

export function registrarCartaYDirecciones(router: Router): void {
  // ── De aquí en adelante hace falta el enlace ───────────────────────────────

  // ── El catálogo es PÚBLICO ─────────────────────────────────────────────────
  // Un enlace de comida se reenvía, se pega en una historia y se busca: quien
  // llegue tiene que poder ver la carta y los precios sin identificarse, como en
  // cualquier tienda. Pedir sigue exigiendo el enlace del bot.
  //
  // Solo salen columnas ya elegidas a mano en `db/repositories/catalog.ts` — sin
  // embeddings, sin SKU, sin nada interno—, y el negocio pasa por
  // `publicBusiness`, que es el mismo saneo que ya usaba la portada.
  router.get('/api/store/:slug/catalog', readStorefrontSession, async (req, res) => {
    const businessId = req.storeBusinessId!
    const business = await db.getBusinessBySlug(String(req.params.slug || '').trim())
    const { status, hours, nextOpen } = await readStatus(business)

    const [
      categories, products, variants, extras, optionGroups, options, recommendations,
    ] = await Promise.all([
      db.getStorefrontCategories(businessId),
      db.getStorefrontProducts(businessId),
      db.getStorefrontVariants(businessId),
      db.getStorefrontExtras(businessId),
      db.getStorefrontOptionGroups(businessId),
      db.getStorefrontOptions(businessId),
      db.getStorefrontRecommendations(businessId),
    ])

    // ⚠️ La regla se consulta UNA vez por catálogo, no por producto: es del
    // negocio, no de cada plato. Falla hacia `null` —sin margen—, que es el lado
    // seguro: el cliente vería el precio del comercio, nunca uno inflado por un
    // error de lectura.
    const pricing = reglaDeMargen(
      await db.getBusinessPricingRule(businessId).catch(() => null),
    )

    // ── El catálogo se puede guardar UNOS SEGUNDOS ────────────────────────
    //
    // Es la petición más cara de la app: 13 consultas y ~2 s de espera medidos
    // contra producción el 2026-09-06. Y su contenido es el MISMO para todo el
    // que mira este local — no lleva ni una línea del cliente que pregunta.
    //
    // ⚠️ `private`, NO `public`, y la diferencia es una defensa. Con `public`,
    // un proxy compartido podría guardarse este 200 y servírselo después a
    // alguien BLOQUEADO, que debe recibir el 403 de `readStorefrontSession`. El
    // navegador de cada cliente sí lo guarda —que es de donde sale la mejora
    // real, porque hoy no hay CDN delante— y ningún intermediario puede repartir
    // la carta a quien el local no quiere atender.
    //
    // ⚠️ `Vary` sobre la cabecera de sesión: si algún día esto pasara a `public`,
    // dos personas con enlaces distintos no compartirían entrada de caché. Es
    // barato ahora y evita que ese cambio futuro sea silenciosamente inseguro.
    //
    // ⚠️ 30 s, no más: el `status` de abierto/cerrado y los precios viajan aquí.
    // Medio minuto de desfase no le cambia nada a nadie —y el dinero lo revalida
    // `create_storefront_order` contra la base, nunca este JSON—, pero un TTL
    // largo dejaría a un local recién abierto pareciendo cerrado.
    res.setHeader('Cache-Control', 'private, max-age=30, stale-while-revalidate=120')
    res.setHeader('Vary', 'x-storefront-token')

    return res.json({
      business: business
        ? {
          ...publicBusiness(business, pricing, await getPlatformPhone().catch(() => null), await tarifaDeServicio()),
          paymentMethods: await metodosDeLaTienda(business),
        }
        : null,
      status,
      canOrder: canOrder(status),
      todaysHours: hours,
      nextOpen,
      ...buildStorefrontCatalog({
        categories: categories as never,
        products: products as never,
        variants: variants as never,
        extras: extras as never,
        optionGroups: optionGroups as never,
        options: options as never,
        recommendations: recommendations as never,
        pricing,
      }),
    })
  })

  /** Quién es el cliente y qué direcciones tiene guardadas EN ESTE negocio. */
  router.get('/api/store/:slug/me', requireStorefrontSession, async (req, res) => {
    const { businessId, customerId, contactPhone } = req.storefront!
    const [addresses, relation] = await Promise.all([
      db.getCustomerAddresses(businessId, customerId),
      db.getBusinessCustomer(businessId, customerId),
    ])
    return res.json({
      // Se devuelve enmascarado: la app solo necesita confirmar "a nombre de…".
      phone: `•••• ${contactPhone.slice(-4)}`,
      name: (relation as { display_name?: string } | null)?.display_name || null,
      addresses,
    })
  })

  // ── El pin y lo que necesita quien reparte ─────────────────────────────────
  //
  // Estos saneos repiten a propósito los CHECK de `customer_addresses`. No es
  // desconfianza de la base —ella es la que manda— sino que el cliente lea «la
  // ubicación no es válida» en vez de un error de restricción de PostgreSQL.

  const TIPOS_DE_EDIFICIO = new Set(['casa', 'departamento', 'oficina', 'hotel', 'otro'])

  interface Ubicacion { latitude: number; longitude: number; accuracyM: number | null }

  /**
   * Lee el pin del cuerpo de la petición.
   *
   * Devuelve `null` cuando no se mandó ninguno —el pin es OPCIONAL: quien niega
   * el permiso del navegador tiene que poder pedir igual— y un error solo cuando
   * lo mandado no sirve.
   *
   * ⚠️ Latitud y longitud viajan JUNTAS o no viajan. Media coordenada no es medio
   * pin: es un punto en el ecuador o en Greenwich, que es peor que no tener nada
   * porque parece un dato.
   */
  const leerUbicacion = (
    body: Record<string, unknown>,
  ): { ok: true; valor: Ubicacion | null } | { ok: false; error: string } => {
    const crudaLat = body.latitude
    const crudaLng = body.longitude
    const vacia = (v: unknown) => v === undefined || v === null || v === ''
    if (vacia(crudaLat) && vacia(crudaLng)) return { ok: true, valor: null }
    if (vacia(crudaLat) || vacia(crudaLng)) {
      return { ok: false, error: 'La ubicación llegó incompleta' }
    }

    const latitude = Number(crudaLat)
    const longitude = Number(crudaLng)
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
      || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return { ok: false, error: 'La ubicación no es válida' }
    }

    // La precisión es opcional y solo informativa: si llega rara se descarta en
    // vez de rechazar el pin, que es el dato que de verdad importa.
    const cruda = Number(body.accuracy)
    const accuracyM = Number.isFinite(cruda) && cruda >= 0 && cruda <= 100000
      ? Math.round(cruda * 10) / 10
      : null

    return { ok: true, valor: { latitude, longitude, accuracyM } }
  }

  router.post('/api/store/:slug/addresses', requireStorefrontSession, async (req, res) => {
    const { businessId, customerId } = req.storefront!
    const body = (req.body || {}) as Record<string, unknown>
    const address = String(body.address || '').trim()
    if (address.length < 5 || address.length > 300) {
      return res.status(400).json({ error: 'La dirección no es válida' })
    }

    const ubicacion = leerUbicacion(body)
    if (!ubicacion.ok) return res.status(400).json({ error: ubicacion.error })

    const tipo = String(body.buildingType || '').trim().toLowerCase()
    if (tipo && !TIPOS_DE_EDIFICIO.has(tipo)) {
      return res.status(400).json({ error: 'Ese tipo de edificio no existe' })
    }

    const created = await db.createCustomerAddress({
      businessId,
      customerId,
      label: String(body.label || 'Casa').slice(0, 40),
      address,
      reference: String(body.reference || '').slice(0, 300) || null,
      latitude: ubicacion.valor?.latitude ?? null,
      longitude: ubicacion.valor?.longitude ?? null,
      accuracyM: ubicacion.valor?.accuracyM ?? null,
      buildingType: tipo || null,
      courierNotes: String(body.courierNotes || '').trim().slice(0, 300) || null,
      isDefault: body.isDefault === true,
    })
    return res.status(201).json(created)
  })

  /**
   * Retira una dirección de la libreta.
   *
   * Se marca inactiva, no se borra: `orders.address_id` apunta aquí y con él se
   * sabe a qué casa pide más un cliente. El destino de cada pedido ya va
   * congelado aparte, así que retirarla no deja ningún reparto sin dirección.
   */
  router.delete('/api/store/:slug/addresses/:id', requireStorefrontSession, async (req, res) => {
    const { businessId, customerId } = req.storefront!
    const retirada = await db.deactivateCustomerAddress({
      businessId,
      customerId,
      addressId: String(req.params.id || ''),
    })
    // No era suya, o ya estaba retirada. Se responde lo mismo en los dos casos:
    // decir «existe pero no es tuya» ya sería contar algo de otro cliente.
    if (!retirada) return res.status(404).json({ error: 'Esa dirección no existe' })
    return res.json({ ok: true })
  })

  /**
   * Le pone el pin a una dirección que ya estaba guardada.
   *
   * Sin esto, las direcciones de siempre —«7 de agosto», sin coordenadas— se
   * quedarían sin ubicación para siempre: el botón solo serviría al estrenar
   * dirección, y el cliente que ya tiene la suya es justo el que más pide.
   */
  router.put('/api/store/:slug/addresses/:id/location', requireStorefrontSession, async (req, res) => {
    const { businessId, customerId } = req.storefront!
    const ubicacion = leerUbicacion((req.body || {}) as Record<string, unknown>)
    if (!ubicacion.ok) return res.status(400).json({ error: ubicacion.error })
    if (!ubicacion.valor) return res.status(400).json({ error: 'No llegó ninguna ubicación' })

    const actualizada = await db.setCustomerAddressLocation({
      businessId,
      customerId,
      addressId: String(req.params.id || ''),
      latitude: ubicacion.valor.latitude,
      longitude: ubicacion.valor.longitude,
      accuracyM: ubicacion.valor.accuracyM,
    })
    // No era suya, o no existe. Se responde lo mismo en los dos casos: decir
    // «existe pero no es tuya» ya sería contar algo de otro cliente.
    if (!actualizada) return res.status(404).json({ error: 'Esa dirección no existe' })
    return res.json(actualizada)
  })
}
