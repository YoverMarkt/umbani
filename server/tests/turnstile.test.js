import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { comprobarFichaHumana, ACCION_DE_ENTRAR } = require('../dist/services/turnstile')
const { esClaveDePruebasDeTurnstile, leerConfiguracionTurnstile } = require('../dist/config/turnstile')

// ═══════════════════════════════════════════════════════════════════════════
// EL CAPTCHA AL PEDIR EL CÓDIGO: la ficha, comprobada en Cloudflare (2026-10-09)
// ═══════════════════════════════════════════════════════════════════════════
//
// Ver `src/services/turnstile.ts`. Lo que se defiende: sin una ficha que
// Cloudflare dé por buena NO sale ningún correo, y si Cloudflare no contesta
// se falla cerrado — nunca «como no sé, dejo pasar».

const SECRETO = '0x4AAAAAAAsecretoDeVerdad'
const SECRETO_DE_PRUEBAS = '1x0000000000000000000000000000000AA'

/** Un Cloudflare de mentira que contesta lo que se le diga. */
const cloudflare = (cuerpo, { ok = true } = {}) =>
  vi.fn(async () => ({ ok, json: async () => cuerpo }))

describe('la ficha se comprueba en Cloudflare', () => {
  it('una ficha buena, de la acción de entrar, es una persona', async () => {
    const pedir = cloudflare({ success: true, action: ACCION_DE_ENTRAR })
    expect(await comprobarFichaHumana('ficha-buena', '190.12.34.56', { secreto: SECRETO, pedir })).toBe('humano')
  })

  it('manda el secreto, la ficha y la IP del cliente, por POST, a siteverify', async () => {
    const pedir = cloudflare({ success: true, action: ACCION_DE_ENTRAR })
    await comprobarFichaHumana('ficha-buena', '190.12.34.56', { secreto: SECRETO, pedir })
    const [url, opciones] = pedir.mock.calls[0]
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    expect(opciones.method).toBe('POST')
    expect(JSON.parse(opciones.body)).toEqual({ secret: SECRETO, response: 'ficha-buena', remoteip: '190.12.34.56' })
  })

  it('sin ficha, vacía o más larga de lo que da Cloudflare: rechazada SIN preguntarle', async () => {
    const pedir = cloudflare({ success: true, action: ACCION_DE_ENTRAR })
    for (const mala of [undefined, null, '', '   ', 42, { ficha: 'x' }, 'x'.repeat(2049)]) {
      expect(await comprobarFichaHumana(mala, '1.2.3.4', { secreto: SECRETO, pedir }), String(mala).slice(0, 20)).toBe('rechazado')
    }
    expect(pedir).not.toHaveBeenCalled()
  })

  it('falsa, vencida o ya usada: rechazada (la app pide otra)', async () => {
    for (const codigo of ['invalid-input-response', 'timeout-or-duplicate']) {
      const pedir = cloudflare({ success: false, 'error-codes': [codigo] })
      expect(await comprobarFichaHumana('ficha', '1.2.3.4', { secreto: SECRETO, pedir }), codigo).toBe('rechazado')
    }
  })

  it('una ficha de OTRO widget (otra acción) no vale aquí', async () => {
    const pedir = cloudflare({ success: true, action: 'otra-cosa' })
    expect(await comprobarFichaHumana('ficha', '1.2.3.4', { secreto: SECRETO, pedir })).toBe('rechazado')
  })

  it('con las claves de PRUEBA la acción llega vacía y no se mira (solo existen en el staging)', async () => {
    const pedir = cloudflare({ success: true, action: '' })
    expect(await comprobarFichaHumana('XXXX.DUMMY.TOKEN.XXXX', '1.2.3.4', { secreto: SECRETO_DE_PRUEBAS, pedir })).toBe('humano')
  })
})

describe('si Cloudflare no contesta, se falla CERRADO', () => {
  it('error de red, respuesta que no es 200, JSON roto o su propio fallo interno: caído', async () => {
    const casos = {
      red: vi.fn(async () => { throw new Error('ECONNRESET') }),
      'no es 200': cloudflare({}, { ok: false }),
      'JSON roto': vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('x') } })),
      'su fallo interno': cloudflare({ success: false, 'error-codes': ['internal-error'] }),
    }
    for (const [caso, pedir] of Object.entries(casos)) {
      expect(await comprobarFichaHumana('ficha', '1.2.3.4', { secreto: SECRETO, pedir }), caso).toBe('caido')
    }
  })

  it('no espera para siempre: al vencer el plazo, caído', async () => {
    // Un Cloudflare que no contesta nunca, pero respeta la señal de cancelar.
    const pedir = vi.fn((_url, { signal }) => new Promise((_ok, mal) => {
      signal.addEventListener('abort', () => mal(signal.reason))
    }))
    const inicio = Date.now()
    expect(await comprobarFichaHumana('ficha', '1.2.3.4', { secreto: SECRETO, pedir, limiteMs: 50 })).toBe('caido')
    expect(Date.now() - inicio).toBeLessThan(2_000)
  })
})

describe('cuándo está encendido', () => {
  it('solo con las DOS claves', () => {
    expect(leerConfiguracionTurnstile({ TURNSTILE_SITE_KEY: 'sitio', TURNSTILE_SECRET_KEY: 'secreto' }))
      .toEqual({ claveDeSitio: 'sitio', secreto: 'secreto' })
    expect(leerConfiguracionTurnstile({ TURNSTILE_SITE_KEY: 'sitio' })).toBeNull()
    expect(leerConfiguracionTurnstile({ TURNSTILE_SECRET_KEY: 'secreto' })).toBeNull()
    expect(leerConfiguracionTurnstile({ TURNSTILE_SITE_KEY: '  ', TURNSTILE_SECRET_KEY: ' ' })).toBeNull()
    expect(leerConfiguracionTurnstile({})).toBeNull()
  })

  it('reconoce las claves de PRUEBA de Cloudflare, y no las de verdad', () => {
    for (const prueba of ['1x00000000000000000000AA', '2x00000000000000000000AB', '1x00000000000000000000BB',
      '3x00000000000000000000FF', '1x0000000000000000000000000000000AA', '2x0000000000000000000000000000000AA']) {
      expect(esClaveDePruebasDeTurnstile(prueba), prueba).toBe(true)
    }
    for (const real of ['0x4AAAAAAABkMYinukE8nzY', '0x4AAAAAAAsecretoDeVerdad', '', undefined]) {
      expect(esClaveDePruebasDeTurnstile(real), String(real)).toBe(false)
    }
  })
})
