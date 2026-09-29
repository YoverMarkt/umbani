import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import jwt from 'jsonwebtoken'

// ═══════════════════════════════════════════════════════════════════════════
// EL REGISTRO DE QUIÉN MUEVE DINERO (2026-09-29)
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo escribe la base con disparadores (lo prueba `verificar-esquema.sql`).
// Aquí se prueba lo que le dice QUIÉN: el actor de la petición viaja en la
// cabecera `x-umbani-actor` de CADA consulta, sin que ninguna ruta tenga que
// acordarse.

const require = createRequire(import.meta.url)
const { conActor, actorActual, conActorEnLaCabecera, CABECERA_DEL_ACTOR } = require('../dist/lib/actor-de-la-peticion')
const auth = require('../dist/middleware/auth')
const cliente = require('../dist/db/client')
const db = require('../dist/db')
const pagosRouter = require('../dist/routes/admin-pagos.routes')

const SECRETO = 'registro-de-dinero-test'
const original = process.env.JWT_SECRET

afterEach(() => {
  vi.restoreAllMocks()
  if (original === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = original
})

/** Un `fetch` de mentira que devuelve las cabeceras con que lo llamaron. */
const fetchQueEnsena = () => vi.fn(async (_url, opciones) => new Headers(opciones?.headers))

describe('la cabecera del actor', () => {
  it('dentro de una petición con actor, cada consulta lo lleva', async () => {
    const base = fetchQueEnsena()
    const f = conActorEnLaCabecera(base)
    const cabeceras = await conActor('superadmin:dueno@umbani.test', () => f('http://base/rest/v1/x', { headers: { apikey: 'k' } }))
    expect(cabeceras.get(CABECERA_DEL_ACTOR)).toBe('superadmin:dueno@umbani.test')
    // Y no se pierde lo que ya llevaba.
    expect(cabeceras.get('apikey')).toBe('k')
  })

  it('llega también a lo que se espera DESPUÉS, en la misma petición', async () => {
    const base = fetchQueEnsena()
    const f = conActorEnLaCabecera(base)
    const cabeceras = await conActor('local:caja@pizza.test', async () => {
      await new Promise(r => setTimeout(r, 5))
      await Promise.resolve()
      return f('http://base/rest/v1/x', {})
    })
    expect(cabeceras.get(CABECERA_DEL_ACTOR)).toBe('local:caja@pizza.test')
  })

  it('fuera de una petición —las tareas de fondo— sale sin actor: la base anota «sistema»', async () => {
    const base = fetchQueEnsena()
    await conActorEnLaCabecera(base)('http://base/rest/v1/x', { headers: { apikey: 'k' } })
    expect(base.mock.calls[0][1]).toEqual({ headers: { apikey: 'k' } })
    expect(actorActual()).toBeNull()
  })

  it('dos peticiones a la vez no se cruzan el actor', async () => {
    const base = fetchQueEnsena()
    const f = conActorEnLaCabecera(base)
    const [a, b] = await Promise.all([
      conActor('superadmin:a@x.test', async () => { await new Promise(r => setTimeout(r, 10)); return f('u', {}) }),
      conActor('local:b@x.test', async () => f('u', {})),
    ])
    expect(a.get(CABECERA_DEL_ACTOR)).toBe('superadmin:a@x.test')
    expect(b.get(CABECERA_DEL_ACTOR)).toBe('local:b@x.test')
  })

  it('nunca pisa una cabecera que ya venía puesta', async () => {
    const base = fetchQueEnsena()
    const cabeceras = await conActor('superadmin:a@x.test', () => conActorEnLaCabecera(base)('u', {
      headers: { [CABECERA_DEL_ACTOR]: 'script:admin:reiniciar-codigos' },
    }))
    expect(cabeceras.get(CABECERA_DEL_ACTOR)).toBe('script:admin:reiniciar-codigos')
  })

  it('solo ASCII imprimible: una cabecera HTTP no admite más, y un salto de línea la partiría', async () => {
    const base = fetchQueEnsena()
    const cabeceras = await conActor('local:josé@café.test\r\nx-otra: 1', () => conActorEnLaCabecera(base)('u', {}))
    expect(cabeceras.get(CABECERA_DEL_ACTOR)).toBe('local:jos@caf.testx-otra: 1')
  })
})

describe('los middlewares ponen el actor', () => {
  const pasar = (middleware, token, req = {}) => new Promise((resolve) => {
    const res = { status() { return this }, json() { resolve({ siguio: false }); return this } }
    middleware({ headers: { authorization: `Bearer ${token}` }, ...req }, res, () => resolve({ siguio: true, actor: actorActual() }))
  })

  it('el superadmin, con su correo', async () => {
    process.env.JWT_SECRET = SECRETO
    const token = jwt.sign({ role: 'admin', mfa: true, email: 'dueno@umbani.test' }, SECRETO)
    expect(await pasar(auth.authAdmin, token)).toEqual({ siguio: true, actor: 'superadmin:dueno@umbani.test' })
  })

  it('el usuario de un local, con su correo', async () => {
    process.env.JWT_SECRET = SECRETO
    const token = jwt.sign({ role: 'client', businessId: 'b1', userId: 'u1', email: 'caja@pizza.test' }, SECRETO)
    expect(await pasar(auth.authClient, token)).toEqual({ siguio: true, actor: 'local:caja@pizza.test' })
  })

  it('y el guardián de sesiones del local, que es por donde entra todo `/api/client`', async () => {
    process.env.JWT_SECRET = SECRETO
    const guardia = auth.createActiveClientGuard({
      database: {
        getClientUserById: async () => ({ id: 'u1', business_id: 'b1', role: 'owner', permissions: [] }),
        getBusinessById: async () => ({ id: 'b1', active: true, suspended: false }),
      },
    })
    const token = jwt.sign({ role: 'client', businessId: 'b1', userId: 'u1', email: 'dueno@pizza.test' }, SECRETO)
    expect(await pasar(guardia, token)).toEqual({ siguio: true, actor: 'local:dueno@pizza.test' })
    // La segunda vez sale de la caché, y el actor sigue ahí.
    expect(await pasar(guardia, token)).toEqual({ siguio: true, actor: 'local:dueno@pizza.test' })
  })
})

describe('los dos clientes de la base llevan la cabecera', () => {
  // Si alguien quita el envoltorio, el registro sigue funcionando… con todo
  // anotado como «sistema». Es el fallo silencioso por excelencia.
  it('el de los repositorios y el de los ajustes', () => {
    const cliente = readFileSync(new URL('../src/db/client.ts', import.meta.url), 'utf8')
    const ajustes = readFileSync(new URL('../src/services/settings.ts', import.meta.url), 'utf8')
    expect(cliente).toContain('fetch: conActorEnLaCabecera(fetchConLimite)')
    expect(ajustes).toContain('fetch: conActorEnLaCabecera(fetch)')
  })

  it('y el script de reinicio del segundo paso se nombra a sí mismo', () => {
    const script = readFileSync(new URL('./reiniciar-segundo-paso.mjs', import.meta.url), 'utf8')
    expect(script).toContain("'x-umbani-actor': 'script:admin:reiniciar-codigos'")
  })
})

describe('la lectura del superadmin', () => {
  it('el repositorio llama a la función de la base con sus argumentos', async () => {
    const rpc = vi.spyOn(cliente, 'rpc').mockResolvedValue({ data: [{ id: 3 }], error: null })
    expect(await db.getMoneyAuditLog({ limite: 50, businessId: 'b1', antesDe: 99 })).toEqual([{ id: 3 }])
    expect(rpc).toHaveBeenCalledWith('money_audit_log_recent', { p_limite: 50, p_business_id: 'b1', p_antes_de: 99 })
    rpc.mockResolvedValue({ data: null, error: { message: 'caída' } })
    await expect(db.getMoneyAuditLog()).rejects.toThrow('caída')
  })

  const despachar = async (query, token) => {
    const capa = pagosRouter.stack.find(c => c.route?.path === '/api/admin/pagos/registro')
    const [guardia, final] = capa.route.stack.map(s => s.handle)
    const r = { status: 200, body: null }
    const res = { status(c) { r.status = c; return this }, json(b) { r.body = b; return this } }
    const req = { query, headers: { authorization: `Bearer ${token}` } }
    let siguio = false
    await guardia(req, res, () => { siguio = true })
    if (siguio) await final(req, res, (e) => { throw e })
    return r
  }

  it('solo el superadmin con segundo paso', async () => {
    process.env.JWT_SECRET = SECRETO
    const leer = vi.spyOn(db, 'getMoneyAuditLog').mockResolvedValue([])
    const local = jwt.sign({ role: 'client', businessId: 'b1' }, SECRETO)
    expect((await despachar({}, local)).status).toBe(403)
    expect(leer).not.toHaveBeenCalled()
  })

  it('acota por local y pagina hacia atrás, y descarta lo que no es válido', async () => {
    process.env.JWT_SECRET = SECRETO
    const token = jwt.sign({ role: 'admin', mfa: true, email: 'dueno@umbani.test' }, SECRETO)
    const leer = vi.spyOn(db, 'getMoneyAuditLog').mockResolvedValue([{ id: 1, action: 'liquidacion_pagada' }])
    const negocio = '11111111-2222-3333-4444-555555555555'
    const r = await despachar({ negocio, antes: '40' }, token)
    expect(r.body).toEqual({ movimientos: [{ id: 1, action: 'liquidacion_pagada' }] })
    expect(leer).toHaveBeenLastCalledWith({ limite: 200, businessId: negocio, antesDe: 40 })
    await despachar({ negocio: "x' or 1=1", antes: '-3' }, token)
    expect(leer).toHaveBeenLastCalledWith({ limite: 200, businessId: null, antesDe: null })
  })
})
