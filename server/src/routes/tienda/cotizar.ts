// La tienda (mini app): cotizar un carrito sin crear el pedido.
// Una sección del router de `storefront.routes.ts`, que las registra EN ORDEN.

import type { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { readStorefrontSession } from '../../middleware/storefront'
import { quoteCart, reglaDeMargen } from '../../services/storefront'
import { tarifaDeServicio } from '../../services/tarifa-de-servicio'
import { cotizacionParaElCliente, porcentajePorProducto } from '../../lib/precio-para-el-cliente'
import { db } from './comun'

export function registrarCotizar(router: Router): void {
  // ── Cotizar sin crear el pedido ────────────────────────────────────────────
  //
  // Devuelve el total EXACTO que se va a cobrar, con su desglose, sin escribir
  // nada. Lo pide el checkout antes de confirmar: la app calcula mientras el
  // cliente elige —para que la pantalla responda al instante— pero el número que
  // se enseña justo antes de pagar tiene que venir del servidor.
  //
  // Usa el mismo `pricing.ts` cuya lógica replica la RPC, así que si la
  // cotización y el cobro difirieran, lo cazan las pruebas que ambos comparten.
  //
  // No crea ni reserva nada, así que va con el catálogo: público y con freno.
  const cotizarLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas consultas, espera un momento' },
  })

  router.post('/api/store/:slug/quote', cotizarLimiter, readStorefrontSession, async (req, res) => {
    const businessId = req.storeBusinessId!
    const body = (req.body || {}) as Record<string, unknown>
    const items = Array.isArray(body.items) ? body.items.slice(0, 50) : []
    if (!items.length) return res.status(400).json({ error: 'No hay nada que cotizar' })

    const [productos, variantes, grupos, opciones, business] = await Promise.all([
      db.getStorefrontProducts(businessId),
      db.getStorefrontVariants(businessId),
      db.getStorefrontOptionGroups(businessId),
      db.getStorefrontOptions(businessId),
      db.getBusinessBySlug(String(req.params.slug || '').trim()),
    ])

    const reglaPrecio = reglaDeMargen(
      await db.getBusinessPricingRule(businessId).catch(() => null),
    )

    const cotizacion = quoteCart({
      items: items as never,
      products: productos as never,
      variants: variantes as never,
      optionGroups: grupos as never,
      options: opciones as never,
      deliveryFee: Number((business as { delivery_fee?: unknown } | null)?.delivery_fee) || 0,
      fulfillment: String(body.fulfillment || 'pickup'),
      pricing: reglaPrecio,
      serviceFee: await tarifaDeServicio(),
    })

    if (cotizacion.error) return res.status(400).json({ error: cotizacion.error })
    // ⚠️ Solo lo que paga el cliente (decisión del dueño, 2026-10-01): hasta
    // aquí viajaban el precio del local y el porcentaje de Umbani.
    return res.json(cotizacionParaElCliente(cotizacion, porcentajePorProducto(reglaPrecio)))
  })
}
