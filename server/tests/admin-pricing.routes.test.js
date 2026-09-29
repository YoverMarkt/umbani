import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import pricingRouter from '../dist/routes/admin-pricing.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')

// ═══════════════════════════════════════════════════════════════════════════
// REGLAS DE MARGEN — LO QUE LA RUTA NO DEJA GUARDAR
// ═══════════════════════════════════════════════════════════════════════════
//
// El saneamiento de esta ruta replica los CHECK de `pricing_rules` a
// propósito, para que el superadmin lea «el porcentaje va entre 0 y 100» en
// vez de una violación de restricción. Estas pruebas cubren lo que la BASE
// también rechaza (`verificar-esquema.sql` lo comprueba allí) y, sobre todo,
// lo que solo vive aquí: los mensajes y los códigos de estado.
//
// Lo que se protege es la configuración del dinero: una regla mal guardada no
// rompe una pantalla, cobra de más a todos los negocios del SaaS.

const JWT_SECRET = 'admin-pricing-test-secret'
const BIZ = '11111111-1111-4111-8111-111111111111'
const REGLA = '22222222-2222-4222-8222-222222222222'

let originalJwtSecret

beforeEach(() => {
  originalJwtSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = JWT_SECRET
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
})

const adminAuth = () => `Bearer ${jwt.sign({ role: 'admin', mfa: true }, JWT_SECRET)}`

async function dispatch(method, path, { auth, body = {}, params = {}, query = {} } = {}) {
  const layer = pricingRouter.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  if (!layer) throw new Error(`No existe ${method.toUpperCase()} ${path}`)
  const handlers = layer.route.stack.map(item => item.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, params, query }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(value) { result.body = value; return this },
  }
  async function run(index) {
    if (index >= handlers.length) return
    let nextCalled = false
    let nextError
    await handlers[index](req, res, error => { nextCalled = true; nextError = error })
    if (nextError) throw nextError
    if (nextCalled) await run(index + 1)
  }
  await run(0)
  return result
}

/** Una regla válida mínima, para variarla en cada caso. */
const REGLA_VALIDA = {
  scope: 'business',
  business_id: BIZ,
  strategy: 'percentage',
  percentage: 10,
}

describe('reglas de margen del superadmin', () => {
  describe('solo el superadmin llega', () => {
    it('sin token no se listan las reglas', async () => {
      expect((await dispatch('get', '/api/admin/pricing-rules')).status).toBe(401)
    })

    it('un token de cliente tampoco', async () => {
      const cliente = `Bearer ${jwt.sign({ role: 'client', businessId: BIZ }, JWT_SECRET)}`
      expect((await dispatch('get', '/api/admin/pricing-rules', { auth: cliente })).status).toBe(403)
    })

    it('todas las rutas exigen autenticación admin', () => {
      // Dos capas por ruta: el guardián y el manejador. Una ruta con una sola
      // sería una que se dejó sin proteger.
      expect(pricingRouter.stack.every(l => l.route.stack.length === 2)).toBe(true)
    })
  })

  describe('lo que no se puede guardar', () => {
    const rechaza = async (cambios, fragmento) => {
      vi.spyOn(db, 'createPricingRule').mockResolvedValue({ data: null, error: null })
      db.createPricingRule.mockClear()
      const r = await dispatch('post', '/api/admin/pricing-rules', {
        auth: adminAuth(),
        body: { ...REGLA_VALIDA, ...cambios },
      })
      expect(r.status).toBe(400)
      expect(r.body.error).toContain(fragmento)
      // Lo importante: ni siquiera se intentó escribir.
      expect(db.createPricingRule).not.toHaveBeenCalled()
    }

    const acepta = async (cambios) => {
      vi.spyOn(db, 'createPricingRule').mockResolvedValue({ data: { id: 'r-1' }, error: null })
      db.createPricingRule.mockClear()
      const r = await dispatch('post', '/api/admin/pricing-rules', {
        auth: adminAuth(),
        body: { ...REGLA_VALIDA, ...cambios },
      })
      expect(r.status, JSON.stringify(cambios)).toBeLessThan(400)
      expect(db.createPricingRule).toHaveBeenCalled()
    }

    it('un ámbito inventado', () => rechaza({ scope: 'galaxia' }, 'ámbito'))

    // Sin esto, una regla «de negocio» sin negocio se guardaría como global y
    // cobraría a TODOS los negocios del SaaS.
    it('una regla de negocio sin negocio', () => rechaza({ business_id: '' }, 'negocio'))
    it('una regla de negocio con un id que no es uuid', () => rechaza({ business_id: 'abc' }, 'negocio'))
    it('una regla por tipo sin el tipo', () =>
      rechaza({ scope: 'business_type', business_id: null, target_name: '' }, 'tipo'))

    it('una estrategia inventada', () => rechaza({ strategy: 'a ojo' }, 'estrategia'))
    it('un porcentaje mayor que 100', () => rechaza({ percentage: 150 }, 'entre 0 y 100'))
    it('un porcentaje negativo', () => rechaza({ percentage: -5 }, 'entre 0 y 100'))
    it('un porcentaje que no es número', () => rechaza({ percentage: 'diez' }, 'entre 0 y 100'))
    it('un margen fijo sin monto', () =>
      rechaza({ strategy: 'fixed', percentage: null }, 'monto'))

    it('unos tramos vacíos', () =>
      rechaza({ strategy: 'tiered', percentage: null, tiers: [] }, 'tramos'))
    it('un tramo sin monto', () =>
      rechaza({ strategy: 'tiered', percentage: null, tiers: [{ up_to: 10 }] }, 'monto'))
    it('un techo de tramo en cero', () =>
      rechaza({ strategy: 'tiered', percentage: null, tiers: [{ up_to: 0, amount: 1 }] }, 'mayor que cero'))

    // Dos tramos sin techo harían impredecible cuál se aplica: el mismo
    // carrito cobraría distinto según cómo se ordenara la lista.
    it('dos tramos sin techo', () => rechaza({
      strategy: 'tiered',
      percentage: null,
      tiers: [{ amount: 1 }, { amount: 2 }],
    }, 'un tramo sin techo'))

    it('un mínimo mayor que el máximo', () =>
      rechaza({ min_amount: 5, max_amount: 2 }, 'mayor que el máximo'))
    it('un mínimo fuera de rango', () => rechaza({ min_amount: 99999 }, 'mínimo'))

    // ⚠️ Esta prueba EXIGÍA lo contrario hasta el 2026-08-25: que `on_top`
    // se rechazara. Su condición —que el catálogo, el carrito y el resumen
    // pinten el precio con margen— se cumplió, así que el freno se levantó.
    // Se reescribió para fijar la regla nueva, no se borró.
    it('acepta los DOS modos, y ninguno más', async () => {
      await acepta({ markup_mode: 'on_top' })
      await acepta({ markup_mode: 'absorbed' })
      await rechaza({ markup_mode: 'inventado' }, 'on_top')
    })
  })

  describe('lo que sí se guarda', () => {
    it('normaliza y guarda una regla de negocio', async () => {
      const guardada = vi.spyOn(db, 'createPricingRule').mockResolvedValue({ data: { id: REGLA }, error: null })
      const r = await dispatch('post', '/api/admin/pricing-rules', {
        auth: adminAuth(),
        body: { ...REGLA_VALIDA, min_amount: 0.5, max_amount: 3, notes: '  con espacios  ' },
      })
      expect(r.status).toBe(201)
      const enviado = guardada.mock.calls[0][0]
      expect(enviado).toMatchObject({
        scope: 'business', business_id: BIZ, strategy: 'percentage',
        // ⚠️ `on_top` es el DEFECTO desde el 2026-08-25: el comercio cobra su
        // precio entero y el margen se suma al del cliente. Antes aquí ponía
        // 'absorbed', que le descontaba el margen al dueño.
        percentage: 10, min_amount: 0.5, max_amount: 3, markup_mode: 'on_top',
      })
      expect(enviado.notes).toBe('con espacios')
      // Una regla de negocio no puede arrastrar un nombre de tipo: sería
      // ambigua sobre a quién se aplica.
      expect(enviado.target_name).toBeNull()
    })

    it('una regla global no arrastra negocio', async () => {
      const guardada = vi.spyOn(db, 'createPricingRule').mockResolvedValue({ data: {}, error: null })
      await dispatch('post', '/api/admin/pricing-rules', {
        auth: adminAuth(),
        body: { scope: 'global', business_id: BIZ, strategy: 'fixed', fixed_amount: 0.5 },
      })
      expect(guardada.mock.calls[0][0].business_id).toBeNull()
    })

    it('ordena y normaliza los tramos', async () => {
      const guardada = vi.spyOn(db, 'createPricingRule').mockResolvedValue({ data: {}, error: null })
      await dispatch('post', '/api/admin/pricing-rules', {
        auth: adminAuth(),
        body: {
          ...REGLA_VALIDA, strategy: 'tiered', percentage: null,
          tiers: [{ up_to: 10, amount: '0.5' }, { amount: '3' }],
        },
      })
      expect(guardada.mock.calls[0][0].tiers).toEqual([
        { up_to: 10, amount: 0.5 },
        { up_to: null, amount: 3 },
      ])
    })

    // El índice único impide dos reglas activas para el mismo destino. Sin
    // este mensaje, el superadmin leería una violación de índice.
    it('explica el choque en vez de soltar el error de la base', async () => {
      vi.spyOn(db, 'createPricingRule').mockResolvedValue({
        data: null,
        error: { message: 'duplicate key value violates unique constraint "idx_pricing_rules_activa_negocio"' },
      })
      const r = await dispatch('post', '/api/admin/pricing-rules', {
        auth: adminAuth(), body: REGLA_VALIDA,
      })
      expect(r.status).toBe(409)
      expect(r.body.error).toContain('ya tiene una regla activa')
    })
  })

  describe('reemplazar y archivar', () => {
    it('reemplazar exige un identificador válido', async () => {
      const r = await dispatch('put', '/api/admin/pricing-rules/:id', {
        auth: adminAuth(), params: { id: 'no-es-uuid' }, body: REGLA_VALIDA,
      })
      expect(r.status).toBe(400)
    })

    it('reemplazar comprueba la regla nueva antes de tocar la anterior', async () => {
      const reemplazo = vi.spyOn(db, 'replacePricingRule').mockResolvedValue({ data: {}, error: null })
      const r = await dispatch('put', '/api/admin/pricing-rules/:id', {
        auth: adminAuth(), params: { id: REGLA },
        body: { ...REGLA_VALIDA, percentage: 500 },
      })
      expect(r.status).toBe(400)
      // Si no se comprobara antes, la anterior quedaría archivada y la nueva
      // sin guardar: el negocio se quedaría sin ninguna regla activa.
      expect(reemplazo).not.toHaveBeenCalled()
    })

    it('archivar exige un identificador válido', async () => {
      const r = await dispatch('delete', '/api/admin/pricing-rules/:id', {
        auth: adminAuth(), params: { id: 'x' },
      })
      expect(r.status).toBe(400)
    })

    it('archiva la regla indicada', async () => {
      const archivar = vi.spyOn(db, 'archivePricingRule').mockResolvedValue({ data: {}, error: null })
      const r = await dispatch('delete', '/api/admin/pricing-rules/:id', {
        auth: adminAuth(), params: { id: REGLA },
      })
      expect(r.status).toBe(200)
      expect(archivar).toHaveBeenCalledWith(REGLA)
    })
  })

  describe('el simulador', () => {
    it('calcula sin guardar nada', async () => {
      const guardada = vi.spyOn(db, 'createPricingRule')
      const r = await dispatch('post', '/api/admin/pricing-rules/simulate', {
        auth: adminAuth(),
        body: { ...REGLA_VALIDA, percentage: 4, max_amount: 3, subtotal: 80 },
      })
      expect(r.status).toBe(200)
      // El techo protege al comercio de volumen: 4 % de 80 son 3.20.
      expect(r.body.markup).toBe(3)
      // ⚠️ Antes esperaba 77 (80 − 3): el margen se le descontaba al comercio.
      // Desde el 2026-08-25 el comercio cobra su precio ENTERO y el margen se
      // suma al del cliente, que es el modelo real del negocio.
      expect(r.body.merchantSubtotal).toBe(80)
      expect(r.body.customerSubtotal).toBe(83)
      expect(guardada).not.toHaveBeenCalled()
    })

    it('rechaza un subtotal que no es número', async () => {
      const r = await dispatch('post', '/api/admin/pricing-rules/simulate', {
        auth: adminAuth(), body: { ...REGLA_VALIDA, subtotal: 'mucho' },
      })
      expect(r.status).toBe(400)
      expect(r.body.error).toContain('subtotal')
    })

    it('rechaza una regla incompleta antes de simular', async () => {
      const r = await dispatch('post', '/api/admin/pricing-rules/simulate', {
        auth: adminAuth(), body: { scope: 'business', strategy: 'percentage', subtotal: 10 },
      })
      expect(r.status).toBe(400)
    })
  })

  describe('el acumulado', () => {
    it('pide el mes en curso cuando no se le dan fechas', async () => {
      const resumen = vi.spyOn(db, 'getPlatformMarkupSummary').mockResolvedValue([])
      await dispatch('get', '/api/admin/pricing-summary', { auth: adminAuth() })
      const [desde, hasta, negocio] = resumen.mock.calls[0]
      expect(desde).toMatch(/^\d{4}-\d{2}-01$/)
      expect(hasta).toMatch(/^\d{4}-\d{2}-01$/)
      expect(new Date(hasta).getTime()).toBeGreaterThan(new Date(desde).getTime())
      // Sin negocio: el superadmin los ve todos.
      expect(negocio).toBeNull()
    })

    it('rechaza fechas con formato inventado', async () => {
      const r = await dispatch('get', '/api/admin/pricing-summary', {
        auth: adminAuth(), query: { from: 'ayer', to: '2026-09-01' },
      })
      expect(r.status).toBe(400)
    })
  })
})
