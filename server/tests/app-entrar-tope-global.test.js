import { afterAll, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { esperarSegundoPlano } from '../dist/lib/segundo-plano.js'

// ═══════════════════════════════════════════════════════════════════════════
// EL TOPE GLOBAL DE CÓDIGOS POR CORREO, CABLEADO DE PUNTA A PUNTA (2026-10-08)
// ═══════════════════════════════════════════════════════════════════════════
//
// En su propio archivo a propósito: el tope vive en el módulo de la ruta y se
// lee de la variable de entorno AL CARGARLA. Vitest da a cada archivo su propio
// proceso, así que aquí se fija en 3 antes de cargarla y se llena sin tocar las
// demás pruebas. Comprueba el camino real: variable → ruta → servicio → tope
// → 503 → registro de errores. Las reglas del servicio, en `entrar-con-correo.test.js`.

const TOPE = 3
const entornoAntes = {
  CORREO_CODIGOS_POR_HORA_EN_TOTAL: process.env.CORREO_CODIGOS_POR_HORA_EN_TOTAL,
  UMBANI_ENTORNO: process.env.UMBANI_ENTORNO,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
}
process.env.CORREO_CODIGOS_POR_HORA_EN_TOTAL = String(TOPE)
// Staging sin proveedor: el código vuelve en la respuesta y no sale ningún correo.
process.env.UMBANI_ENTORNO = 'staging'
delete process.env.RESEND_API_KEY

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const entrar = require('../dist/routes/app-entrar.routes')

afterAll(() => {
  vi.restoreAllMocks()
  for (const [clave, valor] of Object.entries(entornoAntes)) {
    if (valor === undefined) delete process.env[clave]
    else process.env[clave] = valor
  }
})

async function pedirCodigo(correo) {
  const layer = entrar.stack.find(l => l.route?.path === '/api/v1/auth/correo' && l.route?.methods?.post)
  const handlers = layer.route.stack.map(l => l.handle).slice(1) // sin el limitador por IP
  const out = { status: 200, body: undefined, cabeceras: {} }
  const res = {
    status(c) { out.status = c; return this },
    json(v) { out.body = v; return this },
    setHeader(k, v) { out.cabeceras[k] = v },
  }
  for (const h of handlers) {
    let sigue = false
    await h({ headers: {}, body: { correo }, params: {}, query: {}, ip: '1.1.1.1' }, res, () => { sigue = true })
    if (!sigue) break
  }
  return out
}

describe('el tope global de códigos por correo', () => {
  it(`con ${TOPE} códigos en la hora, el siguiente es un 503 que pide volver luego, y queda registrado UNA vez`, async () => {
    vi.spyOn(db, 'contarCodigosDeCorreo').mockResolvedValue(0)
    const guardar = vi.spyOn(db, 'guardarCodigoDeCorreo').mockResolvedValue()
    const registro = vi.spyOn(db, 'recordPlatformError').mockResolvedValue()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Cada uno, un correo distinto: así ataca un bot, y el tope por correo no lo ve.
    for (let i = 0; i < TOPE; i++) {
      expect((await pedirCodigo(`bot${i}@inventado.com`)).status).toBe(201)
    }
    const lleno = await pedirCodigo('otro@inventado.com')
    expect(lleno.status).toBe(503)
    expect(lleno.body.error).toMatch(/Inténtalo en unos minutos/)
    expect(lleno.cabeceras['Retry-After']).toBe('600')
    // El que no cupo no deja código en la base.
    expect(guardar).toHaveBeenCalledTimes(TOPE)

    // Más rechazos no repiten el aviso: uno por cada vez que se llena.
    await pedirCodigo('otro2@inventado.com')
    await esperarSegundoPlano()
    expect(registro).toHaveBeenCalledTimes(1)
    expect(registro.mock.calls[0][0]).toMatchObject({ category: 'envio', code: 'correo_tope_global' })
  })
})
