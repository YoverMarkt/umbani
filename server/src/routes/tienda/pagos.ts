// La tienda (mini app): cómo pagar: la cuenta para transferir, la tarjeta y el comprobante.
// Una sección del router de `storefront.routes.ts`, que las registra EN ORDEN.

import type { Router } from 'express'
import multer from 'multer'
import type { RequestHandler } from 'express'
import { MEDIA_LIMITS, mapMulterError, validateMediaFile } from '../../lib/media'
import { isConfigured, uploadPrivateMedia } from '../../integrations/cloudinary'
import { requireStorefrontSession } from '../../middleware/storefront'
import { pagosConTarjeta } from '../../services/pago-con-tarjeta'
import { db, orderLimiter } from './comun'

export function registrarPagos(router: Router): void {
  // ── Pagar con tarjeta ─────────────────────────────────────────────────────
  //
  // La app pide pagar un pedido YA creado y recibe la URL de la página de
  // PayPhone. ⚠️ El monto no viaja en la petición: sale de `orders.total` en la
  // base (`start_card_payment`), y la pertenencia se comprueba allí con las tres
  // cosas a la vez — negocio, pedido y teléfono de la sesión.
  const RESPUESTA_AL_INICIAR: Record<string, { status: number; error: string }> = {
    no_disponible: { status: 409, error: 'El pago con tarjeta no está disponible ahora mismo' },
    no_encontrado: { status: 404, error: 'No encontramos ese pedido' },
    no_es_tarjeta: { status: 409, error: 'Este pedido no se paga con tarjeta' },
    ya_pagado: { status: 409, error: 'Este pedido ya está pagado' },
    no_cobrable: { status: 409, error: 'Este pedido ya no se puede pagar' },
    demasiados_intentos: { status: 429, error: 'Demasiados intentos de pago. Espera un rato o elige otro método' },
    // Los frenos contra tarjetas robadas (2026-09-29). La tienda no deja cambiar
    // el método de un pedido ya hecho: por eso se dice que lo pida de nuevo.
    tarjeta_apagada: {
      status: 403,
      error: 'Por seguridad, el pago con tarjeta está desactivado 24 horas para tu número tras varios '
        + 'intentos rechazados. Vuelve al menú y pide de nuevo pagando en efectivo o por transferencia.',
    },
    sobre_el_tope: {
      status: 409,
      error: 'Con tarjeta el máximo por pedido es $150. Vuelve al menú y pide de nuevo pagando en efectivo o por transferencia.',
    },
    fallo_proveedor: { status: 502, error: 'No pudimos abrir el pago con tarjeta. Inténtalo de nuevo' },
  }

  router.post('/api/store/:slug/orders/:id/tarjeta', orderLimiter, requireStorefrontSession, async (req, res) => {
    const { businessId, contactPhone } = req.storefront!
    const orderId = String(req.params.id || '').trim()
    const business = await db.getBusinessById(businessId)
    const inicio = await pagosConTarjeta().iniciar({
      businessId,
      orderId,
      telefono: contactPhone,
      nombreDelLocal: String(business?.name || 'Umbani'),
    })
    if (inicio.resultado === 'ok') {
      // `urlApp`: para la app de Flutter, que abre el navegador del sistema sin
      // origen; pasa por nuestra página (`/pagos/payphone/ir`) para que PayPhone
      // vea el dominio registrado.
      const base = String(process.env.BASE_URL || '').replace(/\/+$/, '')
      return res.json({
        url: inicio.url,
        urlApp: base ? `${base}/pagos/payphone/ir?destino=${encodeURIComponent(inicio.url)}` : null,
      })
    }
    const respuesta = RESPUESTA_AL_INICIAR[inicio.resultado] || RESPUESTA_AL_INICIAR.no_disponible
    return res.status(respuesta.status).json({ error: respuesta.error, reason: inicio.resultado })
  })

  /**
   * ¿En qué quedó el cobro? Lo pregunta la pantalla de «confirmando tu pago».
   *
   * ⚠️ Primero se comprueba que el pedido es de la persona de la sesión (el
   * mismo 404 que un pedido que no existe) y solo entonces se lee su cobro.
   */
  router.get('/api/store/:slug/orders/:id/tarjeta', requireStorefrontSession, async (req, res) => {
    const { businessId, contactPhone } = req.storefront!
    const orderId = String(req.params.id || '').trim()
    const { data, error } = await db.getStorefrontOrder({ businessId, contactPhone, orderId })
    if (error) return res.status(500).json({ error: 'No pudimos consultar tu pago' })
    if (!data) return res.status(404).json({ error: 'No encontramos ese pedido' })
    const pedido = data as { status?: string | null; payment_confirmed_at?: string | null }
    const cobro = await db.getLatestCardPayment(businessId, orderId).catch(() => null)
    return res.json({
      pagado: Boolean(pedido.payment_confirmed_at),
      estadoDelPedido: pedido.status || null,
      estado: cobro?.status || null,
      marca: cobro?.card_brand || null,
      ultimos: cobro?.card_last_digits || null,
    })
  })

  // ── Comprobante de la transferencia ────────────────────────────────────────
  //
  // Es OPCIONAL a propósito: el pedido ya está creado cuando se llega aquí, así
  // que un cliente que no encuentra la foto no pierde su pedido.
  //
  // La imagen la sube el SERVIDOR a Cloudinary. La app nunca ve credenciales, y
  // la URL que se guarda es la que devuelve Cloudinary, no una que mande el
  // teléfono: si no, cualquiera colgaría un enlace arbitrario en el pedido.
  const proofUpload: RequestHandler = (req, res, next) => {
    multer({ storage: multer.memoryStorage(), limits: { fileSize: MEDIA_LIMITS.image } })
      .single('file')(req, res, error => {
        if (error) {
          const mapped = mapMulterError(error)
          return res.status(mapped.status).json({ error: mapped.error })
        }
        next()
      })
  }

  router.post(
    '/api/store/:slug/orders/:id/proof',
    orderLimiter,
    requireStorefrontSession,
    proofUpload,
    async (req, res) => {
      const { businessId, contactPhone } = req.storefront!
      if (!req.file) return res.status(400).json({ error: 'No se recibió el comprobante' })

      const invalido = validateMediaFile(req.file)
      if (invalido) return res.status(invalido.status).json({ error: invalido.error })
      if (!req.file.mimetype?.startsWith('image/')) {
        return res.status(400).json({ error: 'El comprobante debe ser una imagen' })
      }
      if (!(await isConfigured())) {
        return res.status(503).json({ error: 'El negocio no puede recibir comprobantes ahora mismo' })
      }

      try {
        // PRIVADO: un comprobante bancario no puede vivir en una URL pública y
        // permanente. Se sube como `authenticated` y solo se ve con una firma
        // temporal que genera el servidor.
        const subida = await uploadPrivateMedia(req.file.buffer, businessId)
        const orderId = String(req.params.id || '')
        const { data, error } = await db.attachStorefrontPaymentProof({
          businessId,
          orderId,
          contactPhone,
          url: subida.url,
          publicId: subida.public_id,
        })
        if (error) {
          console.error('❌ comprobante:', error.message || 'Error desconocido')
          return res.status(500).json({ error: 'No pudimos guardar tu comprobante' })
        }
        const resultado = (data || {}) as { result?: string }
        // La huella y el análisis, sin `await`: el comprobante ya está adjunto y
        // un fallo aquí no puede deshacerlo ni dejar al cliente sin respuesta.
        //
        // ⚠️ EL ANÁLISIS VA AQUÍ, y hasta el 2026-09-13 no iba (lo destapó una
        // prueba de aceptación). `registrarComprobante` no llama a la visión: la
        // ESPERA ya hecha, porque quien la llamó antes no debe pagarla dos veces.
        // Sin pasársela, el comprobante se quedaba en `pendiente_analisis` para
        // siempre: la huella sí se calculaba —el duplicado se cazaba— pero NADIE
        // comprobaba ni el monto ni la cuenta de destino, que son las dos únicas
        // señales críticas. Por esta puerta el dinero entraba sin revisar.
        //
        // ⚠️ Aquí NO corta, y esa es la diferencia deliberada con el chat. Allí
        // la visión corre ANTES de subir, así que un comprobante que no cuadra
        // se rechaza sin gastar almacenamiento ni encender la alarma. Aquí el
        // archivo ya está adjunto cuando se sabe, y el pedido ya está en
        // `pago_en_revision` — que es exactamente el estado donde una PERSONA
        // mira antes de aceptar. Lo que faltaba era que esa persona viera las
        // señales; ahora las ve puntuadas en su panel.
        //
        // ⚠️ Falla ABIERTO en cada paso: sin análisis, sin pedido o ante
        // cualquier excepción se registra como antes. Nunca deja al cliente sin
        // su «ok» ni deshace un comprobante ya adjunto.
        if (resultado.result !== 'not_found') {
          const imagen = req.file.buffer
          const mimeType = req.file.mimetype
          const fileUrl = subida.url
          const filePublicId = subida.public_id
          const perceptualHash = subida.phash ?? null
          void (async () => {
            const vision = require('../../services/receipt-vision') as typeof import('../../services/receipt-vision')
            const ingest = require('../../services/receipt-ingest') as typeof import('../../services/receipt-ingest')
            const analisis = await vision.analizarComprobante(imagen, mimeType)
              .catch(() => undefined)
            const pedido = await db.getOrderForReceiptCheck(businessId, orderId)
              .catch(() => null)
            await ingest.registrarComprobante({
              businessId,
              orderId,
              imagen,
              fileUrl,
              filePublicId,
              perceptualHash,
              mimeType,
              analisis,
              esperado: pedido
                ? {
                  total: Number(pedido.total ?? 0),
                  createdAt: pedido.created_at ?? null,
                  clienteNombre: pedido.contact_name ?? null,
                }
                : undefined,
            })
          })().catch(() => { /* el comprobante ya está adjunto; esto es la capa de encima */ })
        }
        if (resultado.result === 'not_found') {
          return res.status(404).json({ error: 'Ese pedido no es tuyo o ya no existe' })
        }
        if (resultado.result === 'invalid_state') {
          return res.status(409).json({ error: 'Ese pedido ya está cerrado' })
        }
        return res.json({ ok: true })
      } catch (error) {
        console.error('❌ comprobante:', (error as Error).message)
        return res.status(500).json({ error: 'No pudimos subir tu comprobante' })
      }
    },
  )
}
