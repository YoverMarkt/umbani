import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { avisaAlClientePorWhatsApp } from '../dist/config/avisos-al-cliente.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const { procesarAvisosPendientes } = require('../dist/services/outbox-worker')
const { pedirComprobantePorChat } = require('../dist/services/payment-request-notice')
const { avisarAlCliente } = require('../dist/services/order-status-notice')
const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')

// ═══════════════════════════════════════════════════════════════════════════
// AL CLIENTE YA NO SE LE ESCRIBE POR WHATSAPP (2026-10-09)
// ═══════════════════════════════════════════════════════════════════════════
//
// Decisión del dueño: Umbani es SOLO APP. El cliente sigue su pedido en la app
// y sube allí el comprobante. Un solo interruptor, `config/avisos-al-cliente.ts`,
// APAGADO por defecto; el código de los avisos sigue entero (sus pruebas lo
// encienden: `outbox-de-avisos.test.js`, `orders.routes.test.js`…).

let antes
beforeEach(() => {
  antes = process.env.AVISOS_WHATSAPP_AL_CLIENTE
  delete process.env.AVISOS_WHATSAPP_AL_CLIENTE
})
afterEach(() => {
  vi.restoreAllMocks()
  if (antes === undefined) delete process.env.AVISOS_WHATSAPP_AL_CLIENTE
  else process.env.AVISOS_WHATSAPP_AL_CLIENTE = antes
})

describe('el interruptor', () => {
  it('apagado salvo que diga «si», tal cual', () => {
    expect(avisaAlClientePorWhatsApp({})).toBe(false)
    for (const no of ['', 'no', '1', 'true', 'sí ya']) {
      expect(avisaAlClientePorWhatsApp({ AVISOS_WHATSAPP_AL_CLIENTE: no }), no).toBe(false)
    }
    for (const si of ['si', 'SI', ' si ']) {
      expect(avisaAlClientePorWhatsApp({ AVISOS_WHATSAPP_AL_CLIENTE: si }), si).toBe(true)
    }
  })
})

describe('apagado, ninguno de los dos avisos toca nada', () => {
  it('el de estado no reclama ni encola: no queda nada que la cola reintente', async () => {
    const reclamar = vi.spyOn(db, 'claimOrderNotification')
    const encolar = vi.spyOn(db, 'enqueueOutboxEvent')
    await avisarAlCliente('biz-1', 'ord-1', 'preparacion')
    expect(reclamar).not.toHaveBeenCalled()
    expect(encolar).not.toHaveBeenCalled()
  })

  it('«mándanos el comprobante» tampoco: el comprobante se sube en la app', async () => {
    const reclamar = vi.spyOn(db, 'claimOrderNotification')
    expect(await pedirComprobantePorChat('biz-1', 'ord-1')).toBe(false)
    expect(reclamar).not.toHaveBeenCalled()
  })

  it('lo que hubiera quedado en la cola se CIERRA sin enviar: no es un fallo, es una decisión', async () => {
    vi.spyOn(db, 'leaseOutboxEvents').mockResolvedValue([{
      id: 'ev-1', business_id: 'biz-1', aggregate_id: 'ord-1', payload: { status: 'preparacion' }, lease_token: 'tok-1',
    }])
    const cerrar = vi.spyOn(db, 'completeOutboxEvent').mockResolvedValue(true)
    const fallar = vi.spyOn(db, 'failOutboxEvent')
    const leerPedido = vi.spyOn(db, 'getOrderForNotice')

    expect(await procesarAvisosPendientes()).toEqual({ enviados: 0, fallidos: 0, muertos: 0, apagados: 1 })
    expect(cerrar).toHaveBeenCalledWith('ev-1', 'tok-1')
    expect(fallar).not.toHaveBeenCalled()
    expect(leerPedido).not.toHaveBeenCalled()
  })
})

describe('guardián: nadie le escribe al cliente saltándose el interruptor', () => {
  const archivos = (dir) => readdirSync(dir).flatMap((nombre) => {
    const ruta = path.join(dir, nombre)
    if (statSync(ruta).isDirectory()) return archivos(ruta)
    return ruta.endsWith('.ts') ? [ruta] : []
  })

  it('solo mandan por `sendToContact` los dos avisos al cliente y el aviso al DUEÑO', () => {
    // El aviso al dueño del local no pasa por el interruptor: no es al cliente.
    const permitidos = ['services/order-notify.ts', 'services/payment-request-notice.ts', 'services/owner-order-notice.ts']
    const quienes = archivos(src)
      .filter(ruta => /\.sendToContact\(/.test(readFileSync(ruta, 'utf8')))
      .map(ruta => path.relative(src, ruta).split(path.sep).join('/'))
    // Si no encontrara ninguno, este guardián no vigilaría nada.
    expect(quienes.length).toBeGreaterThan(0)
    expect(quienes.filter(q => !permitidos.includes(q))).toEqual([])
  })

  it('y los dos avisos al cliente preguntan al interruptor ANTES de reclamar', () => {
    const estado = readFileSync(path.join(src, 'services/order-status-notice.ts'), 'utf8')
    expect(estado.indexOf('if (!avisaAlClientePorWhatsApp()) return'))
      .toBeLessThan(estado.indexOf('db.claimOrderNotification('))
    const comprobante = readFileSync(path.join(src, 'services/payment-request-notice.ts'), 'utf8')
    expect(comprobante).toContain('avisaAlCliente: () => avisaAlClientePorWhatsApp()')
    expect(comprobante.indexOf('!dependencias.avisaAlCliente()'))
      .toBeLessThan(comprobante.indexOf('dependencias.claimOrderNotification('))
  })
})
