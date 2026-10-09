import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { assertEnvironment, inspectEnvironment } = require('../dist/config/environment')

const validEnvironment = (overrides = {}) => ({
  SUPABASE_URL: 'https://demo.supabase.co',
  SUPABASE_SERVICE_KEY: 'service-key',
  JWT_SECRET: 'j'.repeat(48),
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'a'.repeat(16),
  ...overrides,
})

describe('configuración de entorno', () => {
  it('permite desarrollo sin dominio ni secretos de webhook', () => {
    expect(assertEnvironment(validEnvironment())).toMatchObject({
      production: false,
      missing: [],
      invalid: [],
    })
  })

  it('falla cerrado cuando falta configuración crítica', () => {
    expect(() => assertEnvironment({ NODE_ENV: 'production' })).toThrow(
      /SUPABASE_URL.*JWT_SECRET.*BASE_URL/,
    )
  })

  it('exige secretos fuertes, HTTPS y protección de Telegram en producción', () => {
    const status = inspectEnvironment(validEnvironment({
      NODE_ENV: 'production',
      BASE_URL: 'http://example.com',
      YCLOUD_WEBHOOK_SECRET: 'corto',
      TELEGRAM_BOT_TOKEN: 'telegram-token-valid',
      TELEGRAM_WEBHOOK_SECRET: 'corto',
    }))

    expect(status.missing).toEqual([])
    expect(status.invalid).toEqual(expect.arrayContaining([
      'BASE_URL (origen HTTPS sin ruta, query, hash ni slash final; HTTP solo en localhost)',
      'YCLOUD_WEBHOOK_SECRET (mínimo 32 caracteres)',
      'TELEGRAM_WEBHOOK_SECRET (mínimo 32 caracteres)',
    ]))
  })

  it('acepta localhost HTTP sin exigir un secreto global de YCloud', () => {
    expect(() => assertEnvironment(validEnvironment({
      BASE_URL: 'http://127.0.0.1:3199',
    }))).not.toThrow()
  })

  it.each([
    'https://bot.example.com/',
    'https://bot.example.com/webhooks',
    'https://bot.example.com?source=railway',
    'https://bot.example.com#production',
    'https://user:password@bot.example.com',
  ])('rechaza BASE_URL que no sea un origen canónico puro: %s', (baseUrl) => {
    expect(inspectEnvironment(validEnvironment({
      NODE_ENV: 'production',
      BASE_URL: baseUrl,
    })).invalid).toContain(
      'BASE_URL (origen HTTPS sin ruta, query, hash ni slash final; HTTP solo en localhost)',
    )
  })

  it('acepta el fallback global opcional de YCloud cuando es fuerte', () => {
    expect(() => assertEnvironment(validEnvironment({
      NODE_ENV: 'production',
      BASE_URL: 'https://bot.example.com',
      YCLOUD_WEBHOOK_ENDPOINT_ID: 'endpoint-global',
      YCLOUD_WEBHOOK_SECRET: 'y'.repeat(32),
    }))).not.toThrow()
  })

  it('rechaza un fallback global YCloud incompleto', () => {
    const status = inspectEnvironment(validEnvironment({
      NODE_ENV: 'production',
      BASE_URL: 'https://bot.example.com',
      YCLOUD_WEBHOOK_SECRET: 'y'.repeat(32),
    }))

    expect(status.invalid).toContain(
      'YCLOUD_WEBHOOK_ENDPOINT_ID y YCLOUD_WEBHOOK_SECRET deben configurarse juntos',
    )
  })

  it('valida el formato de una versión Meta configurada manualmente', () => {
    expect(inspectEnvironment(validEnvironment({
      META_GRAPH_API_VERSION: 'v25.0/../../host',
    })).invalid).toContain('META_GRAPH_API_VERSION (formato vN.0)')

    expect(inspectEnvironment(validEnvironment({
      META_GRAPH_API_VERSION: 'v25.0',
    })).invalid).not.toContain('META_GRAPH_API_VERSION (formato vN.0)')
  })

  // El captcha al pedir el código (2026-10-09): con una sola clave nadie
  // entraría, y las de PRUEBA de Cloudflare dejan pasar a cualquiera.
  it('Turnstile en producción: las dos claves juntas, y nunca las de prueba', () => {
    const produccion = (claves) => inspectEnvironment(validEnvironment({
      NODE_ENV: 'production', BASE_URL: 'https://example.com', ...claves,
    })).invalid
    expect(produccion({ TURNSTILE_SITE_KEY: '0x4AAAAAAAsitio' }))
      .toContain('TURNSTILE_SITE_KEY y TURNSTILE_SECRET_KEY deben configurarse juntos')
    expect(produccion({ TURNSTILE_SECRET_KEY: '0x4AAAAAAAsecreto' }))
      .toContain('TURNSTILE_SITE_KEY y TURNSTILE_SECRET_KEY deben configurarse juntos')
    const deVerdad = produccion({ TURNSTILE_SITE_KEY: '0x4AAAAAAAsitio', TURNSTILE_SECRET_KEY: '0x4AAAAAAAsecreto' })
    expect(deVerdad.filter(error => error.includes('TURNSTILE'))).toEqual([])
    const dePrueba = { TURNSTILE_SITE_KEY: '1x00000000000000000000BB', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }
    expect(produccion(dePrueba).some(error => error.includes('claves de PRUEBA'))).toBe(true)
    // En el staging son justo las que tocan: hacen correr el camino de verdad.
    expect(produccion({ ...dePrueba, UMBANI_ENTORNO: 'staging' }).filter(error => error.includes('TURNSTILE'))).toEqual([])
  })
})

