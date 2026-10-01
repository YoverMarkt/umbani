import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

// ═══════════════════════════════════════════════════════════════════════════
// EL CUADRE DIARIO CONTRA PAYPHONE (2026-09-29)
// ═══════════════════════════════════════════════════════════════════════════
//
// Compara cada cobro con lo que dice PayPhone y AVISA. Nunca mueve dinero.
// Ensayado contra producción el 2026-09-30 (solo lectura): 18 cobros reales,
// los 18 cuadraban — 4 devueltos «Cancelada» en PayPhone por el mismo monto
// (uno a las 23:47, pasadas las 20:00) y 14 caducados que PayPhone no tiene.

const require = createRequire(import.meta.url)
const {
  compararCobro, crearCuadre, ahoraEnEcuador, HORA_DEL_CUADRE, PAUSA_ENTRE_CONSULTAS_MS,
} = require('../dist/services/cuadre-payphone')
const cliente = require('../dist/db/client')
const db = require('../dist/db')

afterEach(() => vi.restoreAllMocks())

const aprobadaAlla = (centavos = 893) => ({ tipo: 'respuesta', statusCode: 3, capturedCents: centavos, transactionId: '91' })
const canceladaAlla = (centavos = 893) => ({ tipo: 'respuesta', statusCode: 2, capturedCents: centavos, transactionId: '91' })
const noExiste = { tipo: 'no_existe' }
const fallo = { tipo: 'fallo', definitivo: false, mensaje: 'timeout', codigo: null }
const nuestro = (status, extra = {}) => ({ status, amount_cents: 893, captured_cents: 893, ...extra })

describe('qué cuadra y qué no', () => {
  it('aprobado aquí y allá, por el mismo monto: cuadra', () => {
    expect(compararCobro(nuestro('aprobado'), aprobadaAlla())).toEqual({ resultado: 'cuadra' })
  })

  it('aprobado aquí por otro monto: descuadre GRAVE con las dos cifras', () => {
    const v = compararCobro(nuestro('aprobado'), aprobadaAlla(900))
    expect(v).toMatchObject({ resultado: 'descuadre', grave: true })
    expect(v.detalle).toBe('PayPhone cobró $9.00 y aquí consta $8.93.')
  })

  it('aprobado aquí y NO allá: el pedido se dio por pagado sin dinero', () => {
    expect(compararCobro(nuestro('aprobado'), canceladaAlla())).toMatchObject({ resultado: 'descuadre', grave: true })
    expect(compararCobro(nuestro('aprobado'), noExiste).detalle).toMatch(/PayPhone no tiene este cobro/)
  })

  it('DEVUELTO aquí y cobrado allá: el caso que motivó esto, hay que devolver a mano', () => {
    const v = compararCobro(nuestro('devuelto'), aprobadaAlla())
    expect(v).toMatchObject({ resultado: 'descuadre', grave: true })
    expect(v.detalle).toMatch(/devolverlo a mano/)
    expect(compararCobro(nuestro('devuelto'), canceladaAlla())).toEqual({ resultado: 'cuadra' })
    expect(compararCobro(nuestro('no_confirmado'), canceladaAlla())).toEqual({ resultado: 'cuadra' })
  })

  it('rechazado o caducado aquí y COBRADO allá: el cliente pagó y no se le dio el pedido', () => {
    for (const estado of ['rechazado', 'caducado']) {
      const v = compararCobro(nuestro(estado), aprobadaAlla())
      expect(v, estado).toMatchObject({ resultado: 'descuadre', grave: true })
      expect(v.detalle).toMatch(/el cliente pagó/)
      expect(compararCobro(nuestro(estado), noExiste), estado).toEqual({ resultado: 'cuadra' })
      expect(compararCobro(nuestro(estado), canceladaAlla()), estado).toEqual({ resultado: 'cuadra' })
    }
  })

  it('por devolver y aún cobrado allá: es trabajo de la tarea de cobros, no un aviso', () => {
    expect(compararCobro(nuestro('por_devolver'), aprobadaAlla())).toEqual({ resultado: 'pendiente' })
    expect(compararCobro(nuestro('por_devolver'), canceladaAlla())).toMatchObject({ resultado: 'descuadre', grave: false })
  })

  it('devolución manual: se recuerda cada día mientras siga cobrado allá', () => {
    expect(compararCobro(nuestro('devolucion_manual'), aprobadaAlla())).toMatchObject({ resultado: 'descuadre', grave: true })
    expect(compararCobro(nuestro('devolucion_manual'), canceladaAlla())).toEqual({ resultado: 'cuadra' })
  })

  it('un cobro aún vivo aquí y cobrado allá: grave; sin cobrar, sigue su curso', () => {
    expect(compararCobro(nuestro('iniciado'), aprobadaAlla())).toMatchObject({ resultado: 'descuadre', grave: true })
    expect(compararCobro(nuestro('confirmando'), noExiste)).toEqual({ resultado: 'pendiente' })
  })

  it('si PayPhone no contesta, no se juzga: se pregunta en la próxima vuelta', () => {
    for (const estado of ['aprobado', 'devuelto', 'caducado']) {
      expect(compararCobro(nuestro(estado), fallo)).toEqual({ resultado: 'sin_respuesta' })
    }
  })

  it('el monto que se compara es el cobrado; si no hay, el pedido', () => {
    expect(compararCobro(nuestro('aprobado', { captured_cents: null }), aprobadaAlla(893))).toEqual({ resultado: 'cuadra' })
  })
})

describe('la hora de Ecuador', () => {
  it('a las 10:59 UTC son las 5:59 en Quito; a las 11:00, las 6:00', () => {
    expect(ahoraEnEcuador(new Date('2026-10-01T10:59:00Z'))).toEqual({ fecha: '2026-10-01', hora: 5 })
    expect(ahoraEnEcuador(new Date('2026-10-01T11:00:00Z'))).toEqual({ fecha: '2026-10-01', hora: HORA_DEL_CUADRE })
    // Las 23:30 del 30 en Quito ya son el 1 en UTC: manda la fecha de Quito.
    expect(ahoraEnEcuador(new Date('2026-10-01T04:30:00Z')).fecha).toBe('2026-09-30')
  })
})

// ── La tarea ───────────────────────────────────────────────────────────────

const COBROS = [
  { id: 'p1', business_id: 'b1', business_name: 'Burger Brava', order_id: 'o1', order_number: 7, client_transaction_id: 'ref1', provider_transaction_id: '91', status: 'aprobado', amount_cents: 893, captured_cents: 893, created_at: '2026-09-30T04:48:00Z' },
  { id: 'p2', business_id: 'b1', business_name: 'Burger Brava', order_id: 'o2', order_number: 8, client_transaction_id: 'ref2', provider_transaction_id: '92', status: 'devuelto', amount_cents: 848, captured_cents: 848, created_at: '2026-09-30T04:50:00Z' },
  { id: 'p3', business_id: 'b1', business_name: 'Burger Brava', order_id: 'o3', order_number: 9, client_transaction_id: 'ref3', provider_transaction_id: null, status: 'caducado', amount_cents: 500, captured_cents: null, created_at: '2026-09-30T05:00:00Z' },
  { id: 'p4', business_id: 'b1', business_name: 'Burger Brava', order_id: 'o4', order_number: 10, client_transaction_id: 'ref4', provider_transaction_id: '94', status: 'por_devolver', amount_cents: 700, captured_cents: 700, created_at: '2026-09-30T05:10:00Z' },
  { id: 'p5', business_id: 'b1', business_name: 'Burger Brava', order_id: 'o5', order_number: 11, client_transaction_id: 'ref5', provider_transaction_id: null, status: 'caducado', amount_cents: 500, captured_cents: null, created_at: '2026-09-30T05:20:00Z' },
]

const armar = ({
  ahora = new Date('2026-10-01T12:00:00Z'), // 7:00 en Quito
  ultimo = null,
  respuestas = { ref1: aprobadaAlla(893), ref2: aprobadaAlla(848), ref3: noExiste, ref4: aprobadaAlla(700), ref5: fallo },
  config = { token: 't', storeId: null, modo: 'pruebas' },
} = {}) => {
  const marcas = []
  const alertas = []
  const guardados = []
  const esperas = []
  const consultadas = []
  const deps = {
    configuracion: () => config,
    payphone: () => ({ consultar: async (ref) => { consultadas.push(ref); return respuestas[ref] } }),
    base: {
      paymentsToReconcile: vi.fn(async () => COBROS),
      markPaymentReconciled: vi.fn(async (id, resultado, detalle) => { marcas.push({ id, resultado, detalle }); return true }),
      leerUltimoCuadre: vi.fn(async () => ultimo),
      guardarUltimoCuadre: vi.fn(async (r) => { guardados.push(r) }),
    },
    alertar: vi.fn(async (a) => { alertas.push(a) }),
    registrar: vi.fn(),
    esperar: vi.fn(async (ms) => { esperas.push(ms) }),
    ahora: () => ahora,
  }
  return { cuadrar: crearCuadre(deps), deps, marcas, alertas, guardados, esperas, consultadas }
}

describe('la tarea diaria', () => {
  it('cuadra, marca, avisa SOLO el descuadre y guarda el resumen del día', async () => {
    const m = armar()
    const r = await m.cuadrar()
    expect(r).toEqual({ fecha: '2026-10-01', at: '2026-10-01T12:00:00.000Z', revisados: 3, descuadres: 1, sinRespuesta: 1 })
    // p1 cuadra; p2 devuelto pero cobrado allá → descuadre; p3 cuadra; p4 en
    // camino → ni se marca; p5 sin respuesta → ni se marca.
    expect(m.marcas).toEqual([
      { id: 'p1', resultado: 'cuadra', detalle: null },
      { id: 'p2', resultado: 'descuadre', detalle: expect.stringMatching(/devolverlo a mano/) },
      { id: 'p3', resultado: 'cuadra', detalle: null },
    ])
    expect(m.alertas).toHaveLength(1)
    expect(m.alertas[0]).toMatchObject({ businessId: 'b1', code: 'cuadre_payphone_grave' })
    expect(m.alertas[0].message).toMatch(/Burger Brava · pedido #8: Devuelto aquí/)
    expect(m.alertas[0].context).toMatchObject({ referencia: 'ref2', payphone: '92', estado_aqui: 'devuelto', monto: '$8.48' })
    expect(m.guardados).toEqual([r])
  })

  it('NUNCA cambia el estado de un cobro: solo marca el cuadre', async () => {
    const m = armar()
    await m.cuadrar()
    expect(Object.keys(m.deps.base).sort()).toEqual(['guardarUltimoCuadre', 'leerUltimoCuadre', 'markPaymentReconciled', 'paymentsToReconcile'])
    const fuente = readFileSync(new URL('../src/services/cuadre-payphone.ts', import.meta.url), 'utf8')
    for (const prohibida of ['revertir(', 'settleCardPayment', 'finishCardRefund', 'expireCardPayment', 'confirmar(']) {
      expect(fuente, prohibida).not.toContain(prohibida)
    }
  })

  it('a 15 consultas por minuto como mucho: espera entre una y otra, no antes de la primera', async () => {
    const m = armar()
    await m.cuadrar()
    expect(m.consultadas).toEqual(['ref1', 'ref2', 'ref3', 'ref4', 'ref5'])
    expect(m.esperas).toEqual(Array(COBROS.length - 1).fill(PAUSA_ENTRE_CONSULTAS_MS))
    expect(60_000 / PAUSA_ENTRE_CONSULTAS_MS).toBeLessThanOrEqual(15)
  })

  it('una vez al día: si hoy ya cuadró, no vuelve a consultar', async () => {
    const m = armar({ ultimo: { fecha: '2026-10-01', at: 'x', revisados: 1, descuadres: 0, sinRespuesta: 0 } })
    expect(await m.cuadrar()).toBeNull()
    expect(m.deps.base.paymentsToReconcile).not.toHaveBeenCalled()
    // El de AYER no cuenta: hoy toca.
    const n = armar({ ultimo: { fecha: '2026-09-30', at: 'x', revisados: 1, descuadres: 0, sinRespuesta: 0 } })
    expect(await n.cuadrar()).not.toBeNull()
  })

  it('antes de las 6 de Ecuador no cuadra; forzándolo, sí', async () => {
    const temprano = new Date('2026-10-01T10:30:00Z') // 5:30 en Quito
    expect(await armar({ ahora: temprano }).cuadrar()).toBeNull()
    expect(await armar({ ahora: temprano }).cuadrar({ forzar: true })).not.toBeNull()
  })

  it('sin credenciales de PayPhone no consulta nada, ni la base', async () => {
    const m = armar({ config: null })
    expect(await m.cuadrar()).toBeNull()
    expect(m.deps.base.leerUltimoCuadre).not.toHaveBeenCalled()
  })

  it('si la base falla, avisa y no lanza: la tarea no puede tumbar el servidor', async () => {
    const m = armar()
    m.deps.base.paymentsToReconcile.mockRejectedValueOnce(new Error('Bad Gateway'))
    await expect(m.cuadrar()).resolves.toBeNull()
    expect(m.alertas[0]).toMatchObject({ code: 'cuadre_payphone_fallo' })
    expect(m.alertas[0].message).toMatch(/Bad Gateway/)
  })
})

describe('los repositorios', () => {
  it('llaman a las funciones de la base con sus argumentos', async () => {
    const rpc = vi.spyOn(cliente, 'rpc').mockResolvedValue({ data: [], error: null })
    await db.paymentsToReconcile('pruebas', 50)
    expect(rpc).toHaveBeenLastCalledWith('payments_to_reconcile', { p_environment: 'pruebas', p_limite: 50 })
    rpc.mockResolvedValue({ data: true, error: null })
    expect(await db.markPaymentReconciled('p1', 'descuadre', 'x')).toBe(true)
    expect(rpc).toHaveBeenLastCalledWith('mark_payment_reconciled', { p_id: 'p1', p_resultado: 'descuadre', p_detalle: 'x' })
    rpc.mockResolvedValue({ data: null, error: { message: 'caída' } })
    await expect(db.paymentsToReconcile('pruebas')).rejects.toThrow('caída')
  })

  it('el resumen del cuadre se guarda y se lee; uno ilegible no rompe la pantalla', async () => {
    const upsert = vi.fn(async () => ({ error: null }))
    const maybeSingle = vi.fn(async () => ({ data: { value: '{"fecha":"2026-10-01","at":"t","revisados":3,"descuadres":1,"sinRespuesta":0}' }, error: null }))
    vi.spyOn(cliente, 'from').mockReturnValue({ upsert, select: () => ({ eq: () => ({ maybeSingle }) }) })
    await db.guardarUltimoCuadre({ fecha: '2026-10-01', at: 't', revisados: 3, descuadres: 1, sinRespuesta: 0 })
    expect(upsert.mock.calls[0][0]).toMatchObject({ key: 'payphone_cuadre' })
    expect(await db.leerUltimoCuadre()).toEqual({ fecha: '2026-10-01', at: 't', revisados: 3, descuadres: 1, sinRespuesta: 0 })
    maybeSingle.mockResolvedValueOnce({ data: { value: 'no es json' }, error: null })
    expect(await db.leerUltimoCuadre()).toBeNull()
  })

  it('el resumen NO es un ajuste editable desde el panel', () => {
    const { ALLOWED_KEYS } = require('../dist/services/settings')
    expect(ALLOWED_KEYS).not.toContain('payphone_cuadre')
  })
})

describe('el servidor lo programa', () => {
  it('cada hora, con una primera vuelta a los 3 minutos de arrancar', () => {
    const fuente = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(fuente).toContain('setTimeout(() => { void cuadrarConPayphone() }, 3 * 60 * 1000)')
    expect(fuente).toContain('setInterval(() => { void cuadrarConPayphone() }, 60 * 60 * 1000)')
  })
})
