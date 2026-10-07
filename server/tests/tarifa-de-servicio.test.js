import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { fuenteDeLaTienda } from './fuente-de-la-tienda.mjs'

const require = createRequire(import.meta.url)
const { publicBusiness } = require('../dist/services/storefront')
const { quoteCart } = require('../dist/services/cotizacion')
const { tarifaDeServicio, olvidarTarifa } = require('../dist/services/tarifa-de-servicio')

// ═══════════════════════════════════════════════════════════════════════════
// LA TARIFA DE SERVICIO: la cobra la base; aquí, que la cotización dé EXACTO lo
// mismo (bloque «LA TARIFA DE SERVICIO» de verificar-esquema.sql: $10 + 10 % +
// $0,25 = $11,25) y que la tienda la enseñe antes de confirmar.
// ═══════════════════════════════════════════════════════════════════════════

const producto = { id: 'p1', name: 'Pizza', price: 10, stock: 'disponible', category_id: null }
const regla = { markupMode: 'on_top', strategy: 'percentage', percentage: 10, minAmount: null, maxAmount: null }
const cotizar = (extra = {}) => quoteCart({
  items: [{ productId: 'p1', quantity: 1 }], products: [producto], variants: [], optionGroups: [], options: [],
  deliveryFee: 0, fulfillment: 'pickup', pricing: regla, ...extra,
})

describe('la cotización con tarifa', () => {
  it('$10 del local + $1 de comisión + $0,25 de tarifa = $11,25, igual que la base', () => {
    const q = cotizar({ serviceFee: 0.25 })
    expect(q.total).toBe(11.25)
    expect(q.serviceFee).toBe(0.25)
    // La tarifa va DENTRO de la parte de Umbani, como en `platform_markup`.
    expect(q.platformMarkup).toBe(1.25)
    // El local cobra su precio entero: la tarifa nunca sale de lo suyo.
    expect(q.merchantSubtotal).toBe(10)
  })

  it('apagada no cambia nada', () => {
    expect(cotizar().total).toBe(11)
    expect(cotizar({ serviceFee: 0 }).serviceFee).toBe(0)
  })

  it('con margen absorbido, el cliente paga SOLO la tarifa de más', () => {
    const q = cotizar({ serviceFee: 0.25, pricing: { ...regla, markupMode: 'absorbed' } })
    expect(q.total).toBe(10.25)
    expect(q.merchantSubtotal).toBe(9)
  })

  it('un carrito que no se puede cotizar no inventa tarifa', () => {
    const q = cotizar({ serviceFee: 0.25, items: [{ productId: 'no-existe', quantity: 1 }] })
    expect(q.error).toBeTruthy()
    expect(q.total).toBe(0)
    expect(q.serviceFee).toBe(0)
  })
})

describe('la tienda la enseña antes de confirmar', () => {
  it('el negocio público lleva la tarifa, redondeada y nunca negativa', () => {
    expect(publicBusiness({ id: 'b' }, null, null, 0.25).serviceFee).toBe(0.25)
    expect(publicBusiness({ id: 'b' }, null, null, -3).serviceFee).toBe(0)
    expect(publicBusiness({ id: 'b' }).serviceFee).toBe(0)
  })

  it('la portada, el catálogo y la cotización la piden a la base', () => {
    const rutas = fuenteDeLaTienda()
    expect(rutas.match(/await tarifaDeServicio\(\)/g)).toHaveLength(3)
  })

  it('el carrito la pinta en su propia línea y la suma al total', () => {
    const carrito = fs.readFileSync('../apps/store/src/components/CartSheet.tsx', 'utf8')
    expect(carrito).toMatch(/Tarifa de servicio/)
    expect(carrito).toMatch(/orderTotal\(lines, entrega, deliveryFee, tarifa\)/)
  })
})

describe('se lee una vez por minuto', () => {
  it('guarda lo leído, y si la base falla enseña lo último conocido', async () => {
    olvidarTarifa()
    let lecturas = 0
    const leer = async () => { lecturas++; return 0.25 }
    expect(await tarifaDeServicio(leer, 1_000)).toBe(0.25)
    expect(await tarifaDeServicio(leer, 30_000)).toBe(0.25)
    expect(lecturas).toBe(1)
    expect(await tarifaDeServicio(async () => { throw new Error('caída') }, 90_000)).toBe(0.25)
    olvidarTarifa()
  })
})
