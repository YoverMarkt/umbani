import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

// ═══════════════════════════════════════════════════════════════════════════
// FRENOS CONTRA TARJETAS ROBADAS (2026-09-29)
// ═══════════════════════════════════════════════════════════════════════════
//
// Los frenos viven en PostgreSQL y los prueba `verificar-esquema.sql`. Aquí,
// que el cliente reciba cada negativa en su idioma, y que lo que la tienda le
// promete ANTES de elegir tarjeta sea lo mismo que la base hace cumplir.

const require = createRequire(import.meta.url)
const { metodoTarjeta } = require('../dist/services/pago-con-tarjeta')
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
const rutas = readFileSync(new URL('../src/routes/storefront.routes.ts', import.meta.url), 'utf8')

const frenos = (() => {
  const cuerpo = /create or replace function public\.frenos_de_tarjeta\(\)[\s\S]*?\$\$([\s\S]*?)\$\$/.exec(schema)?.[1] || ''
  const numero = clave => Number(new RegExp(`'${clave}',\\s*(\\d+)`).exec(cuerpo)?.[1])
  return {
    intentos: numero('intentos_por_hora'),
    rechazos: numero('rechazos_por_dia'),
    tope: numero('tope_por_pedido_cents'),
  }
})()

describe('los números que eligió el dueño', () => {
  it('5 intentos por hora, 3 rechazos en 24 h, $150 por pedido', () => {
    expect(frenos).toEqual({ intentos: 5, rechazos: 3, tope: 15000 })
  })
})

describe('lo que la tienda promete es lo que la base cumple', () => {
  it('el método tarjeta avisa del tope ANTES de elegirlo, con la cifra de la base', () => {
    const cifra = `$${frenos.tope / 100}`
    for (const modo of ['pruebas', 'produccion']) {
      expect(metodoTarjeta({ modo, token: 'x' }).help_text, modo).toContain(`Hasta ${cifra} por pedido`)
    }
  })

  it('cada negativa nueva tiene su texto, y dice qué hacer', () => {
    expect(rutas).toMatch(/tarjeta_apagada: \{\s*status: 403,/)
    expect(rutas).toMatch(/sobre_el_tope: \{\s*status: 409,/)
    // La tienda no deja cambiar el método de un pedido ya hecho: el texto
    // tiene que decir que se pida otra vez con otro método.
    const bloque = rutas.slice(rutas.indexOf('tarjeta_apagada: {'), rutas.indexOf('fallo_proveedor:'))
    expect(bloque).toContain('pide de nuevo pagando en efectivo o por transferencia')
    expect(rutas).toContain(`Con tarjeta el máximo por pedido es $${frenos.tope / 100}.`)
  })
})

describe('el tope corre DESPUÉS de que se sume el margen', () => {
  it('su disparador se llama después de `orders_stamp_pricing` (van por orden alfabético)', () => {
    // Si corriera antes, vería el total SIN el margen ni la tarifa, y un
    // pedido de $149 + margen pasaría con tarjeta por encima del tope.
    expect('orders_tope_de_tarjeta' > 'orders_stamp_pricing').toBe(true)
    expect(schema).toMatch(/create trigger orders_tope_de_tarjeta\s+before insert or update of total, payment_method on public\.orders/)
  })
})
