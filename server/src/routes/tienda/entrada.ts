// La tienda (mini app): el enlace corto, la portada y confirmar el número.
// Una sección del router de `storefront.routes.ts`, que las registra EN ORDEN.

import type { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { readStorefrontBlock } from '../../middleware/storefront'
import { getPlatformPhone } from '../../services/platform-channel'
import { checkSession, deviceFingerprint, hashToken, phoneMatchesSession } from '../../services/storefront-session'
import { canOrder, publicBusiness } from '../../services/storefront'
import { tarifaDeServicio } from '../../services/tarifa-de-servicio'
import { db, metodosDeLaTienda, readStatus } from './comun'

export function registrarEntrada(router: Router): void {
  // ── Enlace corto: /s/<token> ───────────────────────────────────────────────
  //
  // Lo que el bot manda por WhatsApp. Existe por una razón de producto, no
  // técnica: el enlace completo medía unos 130 caracteres y en un chat eso se
  // lee como spam. Aquí solo viaja el token, que ya identifica al negocio.
  //
  // No devuelve datos NUNCA, solo redirige — por eso no lleva sesión: quien
  // llegue con un token inventado no averigua nada, y quien llegue con el suyo
  // ya lo tenía. La sesión se sigue validando entera al pedir el catálogo.
  router.get('/s/:code', async (req, res) => {
    const code = String(req.params.code || '').trim()
    if (code) {
      const session = await db.getStorefrontSessionByHash(hashToken(code)).catch(() => null)
      if (session?.business_id) {
        const business = await db.getBusinessById(session.business_id).catch(() => null)
        if (business?.slug) {
          // Se conserva el token en el destino: la tienda lo lee y lo borra de la
          // barra de direcciones.
          return res.redirect(
            302,
            `/t/${encodeURIComponent(business.slug)}?s=${encodeURIComponent(code)}`,
          )
        }
      }
    }
    // Token desconocido: la tienda explicará que hace falta pedir uno propio.
    return res.redirect(302, '/t/_')
  })

  // ── Portada: lo único que se ve sin enlace ─────────────────────────────────
  // Quien reciba un enlace reenviado cae aquí: ve el nombre del negocio y su
  // WhatsApp para pedir el suyo. Nada más: ni catálogo, ni precios, ni clientes.
  router.get('/api/store/:slug', readStorefrontBlock, async (req, res) => {
    const business = await db.getBusinessBySlug(String(req.params.slug || '').trim())
    const { status, hours, nextOpen } = await readStatus(business)
    if (!business?.id || status === 'no_disponible') {
      return res.status(404).json({ error: 'Esta tienda no está disponible' })
    }
    return res.json({
      /**
       * ⚠️ La portada es la ÚNICA pantalla que recibe un bloqueado, y lleva
       * `blocked` para que la app lo sepa ANTES de montar la tienda.
       *
       * El 2026-08-29 el dueño, bloqueado, abrió un enlace viejo, recorrió la
       * carta entera y creó el pedido #74. La app no tenía forma de saberlo: se
       * enteraba —como mucho— al confirmar. Aquí se entera en la primera
       * petición, y pinta el aviso en vez del catálogo.
       *
       * ⚠️ Va con el nombre y el logo del local (lo de siempre) y NADA
       * accionable: ni carta, ni precios, ni checkout. Eso lo rechaza el 403 de
       * `readStorefrontSession` y, en último término, el disparador de la base.
       */
      blocked: req.storefrontBlock
        ? {
          until: req.storefrontBlock.until,
          permanent: req.storefrontBlock.permanent,
        }
        : null,
      /**
       * ⚠️ El enlace con el que se abrió ya no vale (revocado o caducado).
       *
       * La app lo mira ANTES de montar la tienda, igual que `blocked`, y pinta
       * «Tu enlace expiró» en vez de la carta. Si se enterara al pedir la carta,
       * la tienda ya estaría montada y el aviso saldría encima de un menú vacío.
       */
      expired: req.storefrontExpired === true,
      business: {
        // ⚠️ `catch(() => null)`: sin el número del marketplace la tienda abre
        // igual, solo que sin los botones de WhatsApp. Que un fallo leyendo
        // `server_settings` tumbe la PORTADA sería cambiar cuatro botones por
        // una tienda que no carga.
        ...publicBusiness(business, null, await getPlatformPhone().catch(() => null), await tarifaDeServicio()),
        // Los métodos que ESE local acepta. La app los pinta; ya no los lleva
        // escritos a mano. Si la consulta falla se manda una lista vacía en vez
        // de romper la portada: el cliente puede mirar la carta igual, y el
        // checkout lo volverá a comprobar contra la base.
        paymentMethods: await metodosDeLaTienda(business),
      },
      status,
      canOrder: canOrder(status),
      todaysHours: hours,
      nextOpen,
    })
  })

  // ── Confirmar el número: la puerta del enlace ──────────────────────────────
  //
  // El enlace ya no caduca, así que lo que lo protege es esto: para usarlo hay
  // que saber a qué número de WhatsApp se emitió.
  //
  // Antes bastaba con abrirlo primero. Quien reenviaba el enlace ANTES de
  // abrirlo se lo regalaba al primero que hiciera clic, y el cliente legítimo se
  // quedaba fuera de su propia tienda.
  //
  // NO lleva `requireStorefrontSession` a propósito: ese middleware rechaza
  // justo el estado en el que se llega aquí (`necesita_telefono`).
  const verifyLimiter = rateLimit({
    // Mucho más estrecho que el resto de la tienda: aquí se adivinan teléfonos.
    // Ocho intentos por minuto bastan para quien se equivoca escribiendo y no
    // para quien prueba números en serie.
    windowMs: 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos, espera un momento' },
  })

  router.post('/api/store/:slug/session/verify', verifyLimiter, async (req, res) => {
    const token = String(
      req.headers['x-storefront-token']
      || (req.body as { token?: unknown } | null)?.token
      || '',
    ).trim()
    const telefono = String((req.body as { phone?: unknown } | null)?.phone || '').trim()
    if (!token || !telefono) {
      return res.status(400).json({ error: 'Falta el número' })
    }

    const business = await db.getBusinessBySlug(String(req.params.slug || '').trim())
    if (!business?.id) return res.status(404).json({ error: 'Esta tienda no está disponible' })

    const session = await db.getStorefrontSessionByHash(hashToken(token))
    const veredicto = checkSession({
      session: session as never,
      deviceHash: '',
      expectedBusinessId: business.id,
    })
    // Solo se sigue si lo único que falta es el número. Una sesión revocada, de
    // otro negocio o inexistente se rechaza igual que en el resto de la tienda.
    if (!veredicto.session || (veredicto.reason && veredicto.reason !== 'necesita_telefono')) {
      return res.status(401).json({ error: 'Este enlace no es válido', reason: veredicto.reason })
    }

    if (!phoneMatchesSession(veredicto.session.contact_phone, telefono)) {
      // Mismo texto para "no coincide" que para "no existe": quien prueba
      // números no debe poder distinguir un fallo de otro.
      return res.status(401).json({
        error: 'Ese número no coincide con este enlace',
        reason: 'necesita_telefono',
      })
    }

    const deviceHash = deviceFingerprint({
      clientId: typeof req.headers['x-storefront-device'] === 'string'
        ? req.headers['x-storefront-device']
        : '',
      userAgent: req.headers['user-agent'] || '',
      acceptLanguage: req.headers['accept-language'] || '',
    })
    const atada = await db.bindStorefrontSession(veredicto.session.id, deviceHash)
    if (!atada) return res.status(500).json({ error: 'No pudimos confirmar tu número' })

    return res.json({ ok: true })
  })
}
