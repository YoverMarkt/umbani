// El superadmin: el estado de la plataforma (cifras, salud del canal, bloqueos de
// plataforma y el registro de errores). Una sección del router de
// `admin-clients.routes.ts`, que las registra EN ORDEN.

import type { Router } from 'express'
import { diagnoseChannels, tieneCanalPropio, type DiagnosableBusiness } from '../../services/channel-health'
import { getPlatformChannel } from '../../services/platform-channel'
import { recordError } from '../../services/error-log'
import { ALLOWED_ERROR_CATEGORIES, auth, db } from './comun'

export function registrarPlataforma(router: Router): void {
  router.get('/api/admin/stats', auth.authAdmin, async (_req, res) => {
    res.json(await db.getAdminStats())
  })

  // Vigilancia del canal de entrada: responde "¿siguen llegando mensajes?".
  // Existe porque en julio de 2026 el bot estuvo cinco días mudo sin que nada
  // avisara — el servidor vivía, pero ningún WhatsApp entraba.
  //
  // ⚠️ Desde el 2026-08-23 el sujeto es el NÚMERO DE LA PLATAFORMA. Antes se
  // preguntaba por cada local, y con un número compartido esa consulta no
  // encuentra nada nunca: los mensajes del marketplace se encolan con
  // `business_id` NULL. El semáforo por negocio se conserva para quien tenga
  // canal propio, y solo se le pregunta a esos — preguntar por un local de
  // marketplace es gastar una consulta para recibir siempre «null».
  //
  // ⚠️ Se retiró `errorsByBusiness`: lo declaraba el tipo del panel y no lo
  // pintaba nadie, y además descartaba los errores con `business_id` NULL, que
  // hoy son cinco de cada seis. Los errores se leen en su propia pantalla.
  router.get('/api/admin/channel-health', auth.authAdmin, async (_req, res) => {
    const businesses = await db.getAllBusinesses() as DiagnosableBusiness[]
    const conCanalPropio = businesses.filter(tieneCanalPropio)
    const [activity, platformLastInboundAt, platformChannel] = await Promise.all([
      db.getLastInboundByBusiness(conCanalPropio.map(business => business.id)),
      db.getPlatformLastInboundAt(),
      // Un fallo leyendo `server_settings` no puede tumbar la vigilancia entera:
      // se trata como «no configurado», que es lo que el panel sabe pintar.
      getPlatformChannel().catch(() => null),
    ])
    res.json(diagnoseChannels({
      businesses,
      activity,
      platform: {
        configured: Boolean(platformChannel),
        lastInboundAt: platformLastInboundAt,
      },
    }))
  })

  // ── Bloqueo de PLATAFORMA ──────────────────────────────────────────────────
  //
  // Distinto del bloqueo del dueño, y por eso vive aquí y no en el panel del
  // negocio: aquel lo pone un local y solo cierra ese local —que El Puerto te
  // expulse no puede dejarte fuera de Umbani entero—; este lo pone el superadmin
  // y significa que la plataforma deja de atender a esa persona: el bot no
  // responde y NINGÚN local acepta su pedido, ni siquiera de mostrador.
  router.get('/api/admin/blocked', auth.authAdmin, async (_req, res) => {
    res.json(await db.getPlatformBlocked())
  })

  router.put('/api/admin/blocked/:phone', auth.authAdmin, async (req, res) => {
    const phone = decodeURIComponent(req.params.phone)
    const body = req.body as { blocked?: unknown; reason?: unknown }
    const blocked = body?.blocked === true
    const reason = typeof body?.reason === 'string' ? body.reason : null
    try {
      res.json(await db.setPlatformBlocked(phone, blocked, reason))
    } catch (error) {
      // El único fallo esperable es un teléfono mal escrito, y ese sí se le dice
      // al superadmin: cualquier otro se registra sin exponer el detalle.
      const mensaje = error instanceof Error ? error.message : ''
      if (/dígitos/i.test(mensaje)) return res.status(400).json({ error: mensaje })
      console.error('❌ bloqueo de plataforma:', mensaje)
      void recordError({
        businessId: null,
        category: 'servidor',
        code: 'bloqueo de plataforma',
        message: mensaje || 'fallo desconocido',
        context: {},
      })
      res.status(500).json({ error: 'No se pudo actualizar el bloqueo' })
    }
  })

  // Registro de errores para diagnosticar sin entrar a los logs del servidor.
  router.get('/api/admin/errors', auth.authAdmin, async (req, res) => {
    const query = req.query as Record<string, string | undefined>
    res.json(await db.getPlatformErrors({
      category: ALLOWED_ERROR_CATEGORIES.includes(String(query.category))
        ? query.category
        : undefined,
      businessId: query.business_id,
      limit: Number(query.limit) || 200,
    }))
  })

  // Descarga en CSV para compartir el diagnóstico. Los mensajes ya salen
  // saneados de `services/error-log.ts`: sin credenciales ni datos personales.
  router.get('/api/admin/errors/export', auth.authAdmin, async (_req, res) => {
    const errors = await db.getPlatformErrors({ limit: 1000 })
    const rows = [
      ['ultima_vez', 'primera_vez', 'veces', 'categoria', 'codigo', 'negocio', 'mensaje'],
      ...errors.map(error => [
        error.last_seen_at,
        error.first_seen_at,
        String(error.occurrences),
        error.category,
        error.code || '',
        error.business_id || 'plataforma',
        error.message,
      ]),
    ]
    const csv = rows
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const stamp = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="errores-${stamp}.csv"`)
    res.send(`﻿${csv}`)
  })
}
