import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { leerConfiguracionPayphone, estadoDePayphone } = require('../dist/config/payphone')
const {
  crearClientePayphone, leerCobro, leerFallo, PAYPHONE_URL,
} = require('../dist/integrations/payphone')
const {
  crearPagosConTarjeta, tarjetaDisponible, metodoTarjeta,
} = require('../dist/services/pago-con-tarjeta')
const { textoDelAviso } = require('../dist/services/order-notify')

// ═══════════════════════════════════════════════════════════════════════════
// EL COBRO CON TARJETA (PAYPHONE)
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo que estas pruebas defienden, por orden de lo que costaría fallar:
//
//   1. Nunca se CAPTURA un cobro que la base dijo que no (`dont_confirm`):
//      sin `Confirm`, PayPhone devuelve el dinero solo.
//   2. El cobro se confirma aunque el teléfono NO vuelva (se le fue el 4G):
//      la tarea lo busca por nuestra referencia.
//   3. Un cobro de PRUEBAS nunca lo confirma un servidor en producción, ni al
//      revés — es lo que impide la comida gratis.
//   4. El monto viaja en CENTAVOS ENTEROS desde la base; un monto que no es
//      entero llega como nulo y la base lo trata como descuadre.
//   5. Lo que no cuadra se ALERTA en la categoría «pagos».
//
// La aritmética del dinero y la decisión de confirmar viven en PostgreSQL y
// se prueban en `tests/sql/verificar-esquema.sql` (bloque «PAGO CON TARJETA»).

const CONFIG = { token: 'tok-secreto', storeId: 'store-1', modo: 'pruebas' }

// ── Un PayPhone falso que registra lo que se le pidió ─────────────────────
function payphoneFalso(respuestas = {}) {
  const llamadas = { preparar: [], confirmar: [], consultar: [], revertir: [] }
  return {
    llamadas,
    cliente: {
      async preparar(cobro) {
        llamadas.preparar.push(cobro)
        return respuestas.preparar ?? { urlTarjeta: `${PAYPHONE_URL}/Anonymous/Index?paymentId=X`, paymentId: 'X' }
      },
      async confirmar(id, ref) {
        llamadas.confirmar.push({ id, ref })
        return respuestas.confirmar ?? {
          tipo: 'respuesta', statusCode: 3, transactionId: id, capturedCents: 350,
          currency: 'USD', authorizationCode: 'A1', cardBrand: 'Visa', lastDigits: '4242', mensaje: 'Approved',
        }
      },
      async consultar(ref) {
        llamadas.consultar.push(ref)
        return respuestas.consultar ?? { tipo: 'no_existe' }
      },
      async revertir(id) {
        llamadas.revertir.push(id)
        return respuestas.revertir ?? { tipo: 'revertido' }
      },
    },
  }
}

// ── Una base falsa: cada función contesta lo que la prueba le diga ────────
function baseFalsa(respuestas = {}) {
  const llamadas = []
  const anotar = (nombre, valor) => async (...args) => {
    llamadas.push({ nombre, args })
    return typeof valor === 'function' ? valor(...args) : valor
  }
  return {
    llamadas,
    base: {
      startCardPayment: anotar('start', respuestas.start ?? {
        result: 'ok', clientTransactionId: 'abcdef1234567890abcdef1234567890', amountCents: 350, orderNumber: 7,
      }),
      claimCardPayment: anotar('claim', respuestas.claim ?? {
        result: 'confirm', orderId: 'o1', businessId: 'b1', environment: 'pruebas',
        providerTransactionId: '9001', amountCents: 350,
      }),
      settleCardPayment: anotar('settle', respuestas.settle ?? { result: 'approved', orderId: 'o1', businessId: 'b1' }),
      leaseCardPayments: anotar('lease', respuestas.lease ?? []),
      expireCardPayment: anotar('expire', respuestas.expire ?? true),
      finishCardRefund: anotar('finish', respuestas.finish ?? true),
    },
  }
}

function montar({ config = CONFIG, base, payphone, ahora } = {}) {
  const alertas = []
  const avisos = []
  const pagos = crearPagosConTarjeta({
    configuracion: () => config,
    payphone: () => payphone.cliente,
    base: base.base,
    urlPublica: () => 'https://umbani.test',
    alertar: async (alerta) => { alertas.push(alerta) },
    avisarAlDueno: async (businessId, orderId) => { avisos.push({ businessId, orderId }) },
    ahora,
  })
  return { pagos, alertas, avisos }
}

const REF = 'abcdef1234567890abcdef1234567890'

// ═══════════════════════════════════════════════════════════════════════════
describe('las credenciales: solo variables de entorno y fallan cerrado', () => {
  it('sin token o sin modo, no hay tarjeta', () => {
    expect(leerConfiguracionPayphone({})).toBeNull()
    expect(leerConfiguracionPayphone({ PAYPHONE_TOKEN: 't', PAYPHONE_STORE_ID: 's' })).toBeNull()
    expect(leerConfiguracionPayphone({ PAYPHONE_STORE_ID: 's', PAYPHONE_MODO: 'pruebas' })).toBeNull()
  })

  it('el Store ID es OPCIONAL: sin él, PayPhone usa la tienda del token', () => {
    // 2026-09-27: con el «Identificador» de la consola, PayPhone respondió
    // «La tienda asociada no existe» (error 100). Ese campo no era el Store ID.
    expect(leerConfiguracionPayphone({ PAYPHONE_TOKEN: 't', PAYPHONE_MODO: 'pruebas' }))
      .toEqual({ token: 't', storeId: null, modo: 'pruebas' })
    expect(leerConfiguracionPayphone({ PAYPHONE_TOKEN: 't', PAYPHONE_STORE_ID: '  ', PAYPHONE_MODO: 'pruebas' })?.storeId)
      .toBeNull()
  })

  it('el modo no se adivina: solo «pruebas» o «produccion», exactos', () => {
    const base = { PAYPHONE_TOKEN: 't', PAYPHONE_STORE_ID: 's' }
    expect(leerConfiguracionPayphone({ ...base, PAYPHONE_MODO: 'test' })).toBeNull()
    expect(leerConfiguracionPayphone({ ...base, PAYPHONE_MODO: 'sandbox' })).toBeNull()
    expect(leerConfiguracionPayphone({ ...base, PAYPHONE_MODO: 'Pruebas ' })?.modo).toBe('pruebas')
    expect(leerConfiguracionPayphone({ ...base, PAYPHONE_MODO: 'produccion' })?.modo).toBe('produccion')
  })

  it('lo que se enseña nunca lleva el token ni el Store ID', () => {
    const estado = estadoDePayphone({ PAYPHONE_TOKEN: 'secreto', PAYPHONE_STORE_ID: 'tienda', PAYPHONE_MODO: 'pruebas' })
    expect(estado).toEqual({ configurado: true, modo: 'pruebas' })
    expect(JSON.stringify(estado)).not.toMatch(/secreto|tienda/)
  })

  it('el token NO se puede guardar desde el panel del superadmin', () => {
    // Si viviera en `server_settings`, quien entrara al superadmin pondría el
    // token de SU cuenta y se quedaría con los cobros.
    // (La COMISIÓN de PayPhone sí vive allí —`payphone_fee_bps`—: es un
    // porcentaje que solo sirve para estimar; no mueve dinero.)
    const ajustes = fs.readFileSync('src/services/settings.ts', 'utf8')
    expect(ajustes).not.toMatch(/payphone_(token|store)|PAYPHONE_TOKEN|PAYPHONE_STORE/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('¿se ofrece la tarjeta en este local?', () => {
  it('solo si el superadmin la encendió Y el servidor cobra en ese MISMO modo', () => {
    expect(tarjetaDisponible({ card_mode: 'pruebas' }, CONFIG)).toBe(true)
    expect(tarjetaDisponible({ card_mode: null }, CONFIG)).toBe(false)
    expect(tarjetaDisponible({}, CONFIG)).toBe(false)
    expect(tarjetaDisponible({ card_mode: 'pruebas' }, null)).toBe(false)
  })

  it('un local REAL no ve la tarjeta con el servidor en pruebas (comida gratis)', () => {
    expect(tarjetaDisponible({ card_mode: 'produccion' }, CONFIG)).toBe(false)
    expect(tarjetaDisponible({ card_mode: 'pruebas' }, { ...CONFIG, modo: 'produccion' })).toBe(false)
  })

  it('en pruebas, la propia lista de métodos avisa que no se cobra dinero real', () => {
    expect(metodoTarjeta(CONFIG).help_text).toMatch(/PRUEBA/)
    expect(metodoTarjeta({ ...CONFIG, modo: 'produccion' }).help_text).not.toMatch(/PRUEBA/)
    expect(metodoTarjeta(CONFIG)).toMatchObject({ code: 'tarjeta', is_prepaid: true, requires_proof: false })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('el cliente de PayPhone', () => {
  const httpFalso = (respuesta, fallo) => {
    const llamadas = []
    const responder = async (url, body, config) => {
      llamadas.push({ url, body, config })
      if (fallo) throw fallo
      return { data: respuesta }
    }
    return {
      llamadas,
      http: { post: responder, get: (url, config) => responder(url, undefined, config) },
    }
  }

  it('prepara el cobro con el monto en centavos, como una sola parte, y el token en la cabecera', async () => {
    const falso = httpFalso({ paymentId: 'P1', payWithCard: `${PAYPHONE_URL}/Anonymous/Index?paymentId=P1` })
    const cliente = crearClientePayphone({ token: 'tok', storeId: 'st', http: falso.http })
    const r = await cliente.preparar({
      referencia: REF, centavos: 1518, urlRespuesta: 'https://u/r', urlCancelacion: 'https://u/c', motivo: 'Pedido #7',
    })
    expect(r.urlTarjeta).toContain(PAYPHONE_URL)
    const { url, body, config } = falso.llamadas[0]
    expect(url).toBe(`${PAYPHONE_URL}/api/button/Prepare`)
    // PayPhone exige que `amount` sea la suma EXACTA de las partes.
    expect(body).toMatchObject({ amount: 1518, amountWithoutTax: 1518, currency: 'USD', clientTransactionId: REF, storeId: 'st' })
    expect(body.amountWithTax).toBeUndefined()
    expect(config.headers.Authorization).toBe('Bearer tok')
  })

  it('sin Store ID no se manda el campo; con él, sí', async () => {
    const sin = httpFalso({ payWithCard: `${PAYPHONE_URL}/Anonymous/Index?paymentId=P1` })
    await crearClientePayphone({ token: 'tok', storeId: null, http: sin.http })
      .preparar({ referencia: REF, centavos: 100, urlRespuesta: 'x', urlCancelacion: 'y', motivo: 'm' })
    expect('storeId' in sin.llamadas[0].body).toBe(false)
    const con = httpFalso({ payWithCard: `${PAYPHONE_URL}/Anonymous/Index?paymentId=P1` })
    await crearClientePayphone({ token: 'tok', storeId: 'st', http: con.http })
      .preparar({ referencia: REF, centavos: 100, urlRespuesta: 'x', urlCancelacion: 'y', motivo: 'm' })
    expect(con.llamadas[0].body.storeId).toBe('st')
  })

  it('jamás manda al cliente a una URL que no sea de PayPhone', async () => {
    const falso = httpFalso({ payWithCard: 'https://phishing.example/pagar' })
    const cliente = crearClientePayphone({ token: 'tok', storeId: 'st', http: falso.http })
    const r = await cliente.preparar({ referencia: REF, centavos: 100, urlRespuesta: 'x', urlCancelacion: 'y', motivo: 'm' })
    expect(r.tipo).toBe('fallo')
  })

  it('no prepara montos que no son centavos enteros', async () => {
    const falso = httpFalso({})
    const cliente = crearClientePayphone({ token: 'tok', storeId: 'st', http: falso.http })
    for (const centavos of [0, -5, 10.5, Number.NaN]) {
      const r = await cliente.preparar({ referencia: REF, centavos, urlRespuesta: 'x', urlCancelacion: 'y', motivo: 'm' })
      expect(r.tipo).toBe('fallo')
    }
    expect(falso.llamadas).toHaveLength(0)
  })

  it('un monto que no es entero llega como NULO (la base lo trata como descuadre)', () => {
    expect(leerCobro({ statusCode: 3, amount: 350 }).capturedCents).toBe(350)
    expect(leerCobro({ statusCode: 3, amount: 3.5 }).capturedCents).toBeNull()
    expect(leerCobro({ statusCode: 3, amount: '350' }).capturedCents).toBe(350)
    expect(leerCobro({ statusCode: 3 }).capturedCents).toBeNull()
    expect(leerCobro({ amount: 350 })).toBeNull()
  })

  it('no guarda datos del titular: solo marca, últimos dígitos y autorización', () => {
    const cobro = leerCobro({
      statusCode: 3, amount: 350, transactionId: 9001, cardBrand: 'Visa', lastDigits: '4242',
      authorizationCode: 'A1', email: 'ana@correo.ec', document: '1712345678', phoneNumber: '0999',
    })
    expect(JSON.stringify(cobro)).not.toMatch(/ana@correo|1712345678|0999/)
    expect(cobro).toMatchObject({ transactionId: '9001', cardBrand: 'Visa', lastDigits: '4242', authorizationCode: 'A1' })
  })

  it('distingue «PayPhone dijo que no» de «no se pudo preguntar»', () => {
    expect(leerFallo({ response: { status: 400, data: { message: 'No existe', errorCode: 20 } } }))
      .toMatchObject({ definitivo: true, codigo: 20, mensaje: 'No existe' })
    expect(leerFallo({ response: { status: 429 } }).definitivo).toBe(false)
    expect(leerFallo({ response: { status: 503 } }).definitivo).toBe(false)
    expect(leerFallo(new Error('timeout of 15000ms exceeded')).definitivo).toBe(false)
  })

  it('el error nunca repite el token', () => {
    const fallo = leerFallo({ response: { status: 401, data: {} }, config: { headers: { Authorization: 'Bearer tok' } } })
    expect(JSON.stringify(fallo)).not.toContain('tok')
  })

  it('la consulta por referencia prefiere el cobro APROBADO si hay varios', async () => {
    const falso = httpFalso([
      { statusCode: 2, transactionId: 1, amount: 350 },
      { statusCode: 3, transactionId: 2, amount: 350 },
    ])
    const cliente = crearClientePayphone({ token: 'tok', storeId: 'st', http: falso.http })
    const r = await cliente.consultar(REF)
    expect(r).toMatchObject({ statusCode: 3, transactionId: '2' })
    expect(falso.llamadas[0].url).toBe(`${PAYPHONE_URL}/api/Sale/client/${REF}`)
  })

  it('«no existe» es una respuesta, no un fallo', async () => {
    const error = { response: { status: 400, data: { message: 'La transacción no existe', errorCode: 20 } } }
    const cliente = crearClientePayphone({ token: 'tok', storeId: 'st', http: httpFalso(null, error).http })
    expect((await cliente.consultar(REF)).tipo).toBe('no_existe')
  })

  it('revertir: `true` es devuelto; cualquier otra cosa, no', async () => {
    const bien = crearClientePayphone({ token: 't', storeId: 's', http: httpFalso(true).http })
    expect((await bien.revertir('9001')).tipo).toBe('revertido')
    const raro = crearClientePayphone({ token: 't', storeId: 's', http: httpFalso({ ok: 1 }).http })
    expect((await raro.revertir('9001')).tipo).toBe('fallo')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('iniciar un cobro', () => {
  it('sin PayPhone configurado no toca ni la base', async () => {
    const base = baseFalsa()
    const { pagos } = montar({ config: null, base, payphone: payphoneFalso() })
    expect(await pagos.iniciar({ businessId: 'b1', orderId: 'o1', telefono: '593', nombreDelLocal: 'L' }))
      .toEqual({ resultado: 'no_disponible' })
    expect(base.llamadas).toHaveLength(0)
  })

  it('el monto que se prepara es el que devuelve la BASE, no uno de la petición', async () => {
    const base = baseFalsa({ start: { result: 'ok', clientTransactionId: REF, amountCents: 1518, orderNumber: 7 } })
    const payphone = payphoneFalso()
    const { pagos } = montar({ base, payphone })
    const r = await pagos.iniciar({ businessId: 'b1', orderId: 'o1', telefono: '593', nombreDelLocal: 'Monster' })
    expect(r.resultado).toBe('ok')
    expect(payphone.llamadas.preparar[0]).toMatchObject({ referencia: REF, centavos: 1518 })
    // El modo del servidor viaja a la base, que lo compara con el del local.
    expect(base.llamadas[0].args[0]).toMatchObject({ environment: 'pruebas', contactPhone: '593' })
    expect(payphone.llamadas.preparar[0].urlRespuesta).toBe('https://umbani.test/pagos/payphone/retorno')
  })

  it('traduce cada negativa de la base sin llamar a PayPhone', async () => {
    const casos = {
      not_found: 'no_encontrado', already_paid: 'ya_pagado', not_payable: 'no_cobrable',
      too_many_attempts: 'demasiados_intentos', card_unavailable: 'no_disponible', not_card: 'no_es_tarjeta',
    }
    for (const [result, resultado] of Object.entries(casos)) {
      const payphone = payphoneFalso()
      const { pagos } = montar({ base: baseFalsa({ start: { result } }), payphone })
      expect((await pagos.iniciar({ businessId: 'b', orderId: 'o', telefono: 't', nombreDelLocal: 'L' })).resultado).toBe(resultado)
      expect(payphone.llamadas.preparar).toHaveLength(0)
    }
  })

  it('si PayPhone no prepara el cobro, se alerta y el cliente lo sabe', async () => {
    const payphone = payphoneFalso({ preparar: { tipo: 'fallo', definitivo: false, mensaje: 'caído', codigo: null } })
    const { pagos, alertas } = montar({ base: baseFalsa(), payphone })
    expect((await pagos.iniciar({ businessId: 'b', orderId: 'o', telefono: 't', nombreDelLocal: 'L' })).resultado).toBe('fallo_proveedor')
    expect(alertas[0].code).toBe('tarjeta_no_se_preparo')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('confirmar un cobro', () => {
  it('⚠️ si la base dice que NO, jamás se llama a Confirm (PayPhone lo devuelve solo)', async () => {
    const payphone = payphoneFalso()
    const base = baseFalsa({ claim: { result: 'dont_confirm', reason: 'Ya se pagó con otro intento', orderId: 'o1', businessId: 'b1' } })
    const { pagos } = montar({ base, payphone })
    expect((await pagos.confirmar(REF, '9002')).resultado).toBe('no_confirmado')
    expect(payphone.llamadas.confirmar).toHaveLength(0)
    expect(base.llamadas.map(l => l.nombre)).not.toContain('settle')
  })

  it('aprobado y cuadrado: se asienta con los centavos de PayPhone y se avisa al dueño', async () => {
    const payphone = payphoneFalso()
    const base = baseFalsa()
    const { pagos, avisos } = montar({ base, payphone })
    const r = await pagos.confirmar(REF, '9001')
    expect(r.resultado).toBe('aprobado')
    const settle = base.llamadas.find(l => l.nombre === 'settle').args[0]
    expect(settle).toMatchObject({ clientTransactionId: REF, providerTransactionId: '9001', statusCode: 3, capturedCents: 350 })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(avisos).toEqual([{ businessId: 'b1', orderId: 'o1' }])
  })

  it('el dueño NO recibe aviso si el cobro no se aprobó', async () => {
    const base = baseFalsa({ settle: { result: 'rejected', orderId: 'o1', businessId: 'b1' } })
    const { pagos, avisos } = montar({ base, payphone: payphoneFalso() })
    expect((await pagos.confirmar(REF, '9001')).resultado).toBe('rechazado')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(avisos).toHaveLength(0)
  })

  it('lo que no cuadra se alerta en «pagos» y queda para devolver', async () => {
    const base = baseFalsa({ settle: { result: 'refund', reason: 'Descuadre: PayPhone cobró 1 centavos', orderId: 'o1', businessId: 'b1' } })
    const { pagos, alertas } = montar({ base, payphone: payphoneFalso() })
    expect((await pagos.confirmar(REF, '9001')).resultado).toBe('devolver')
    expect(alertas[0]).toMatchObject({ code: 'tarjeta_a_devolver', businessId: 'b1' })
  })

  it('⚠️ un cobro de PRODUCCIÓN no lo confirma un servidor en pruebas (ni al revés)', async () => {
    const payphone = payphoneFalso()
    const base = baseFalsa({ claim: {
      result: 'confirm', orderId: 'o1', businessId: 'b1', environment: 'produccion', providerTransactionId: '9001',
    } })
    const { pagos, alertas } = montar({ base, payphone })
    expect((await pagos.confirmar(REF, '9001')).resultado).toBe('pendiente')
    expect(payphone.llamadas.confirmar).toHaveLength(0)
    expect(alertas[0].code).toBe('tarjeta_sin_configuracion')
  })

  it('PayPhone caído: no se asienta nada, queda para la tarea', async () => {
    const base = baseFalsa()
    const payphone = payphoneFalso({ confirmar: { tipo: 'fallo', definitivo: false, mensaje: 'timeout', codigo: null } })
    const { pagos } = montar({ base, payphone })
    expect((await pagos.confirmar(REF, '9001')).resultado).toBe('pendiente')
    expect(base.llamadas.map(l => l.nombre)).not.toContain('settle')
  })

  it('«ya estaba confirmada»: se pregunta por la referencia en vez de adivinar', async () => {
    const base = baseFalsa()
    const payphone = payphoneFalso({
      confirmar: { tipo: 'fallo', definitivo: true, mensaje: 'Transacción ya confirmada', codigo: 5 },
      consultar: { tipo: 'respuesta', statusCode: 3, transactionId: '9001', capturedCents: 350, currency: 'USD' },
    })
    const { pagos } = montar({ base, payphone })
    expect((await pagos.confirmar(REF, '9001')).resultado).toBe('aprobado')
    expect(payphone.llamadas.consultar).toEqual([REF])
  })

  it('una referencia o un id inventados no llegan ni a la base', async () => {
    const base = baseFalsa()
    const { pagos } = montar({ base, payphone: payphoneFalso() })
    expect((await pagos.confirmar("x' or 1=1 --", '9001')).resultado).toBe('no_encontrado')
    expect(base.llamadas).toHaveLength(0)
    // Un id que no es numérico viaja como nulo: la base no lo guarda.
    await pagos.confirmar(REF, '9001; drop table')
    expect(base.llamadas[0].args).toEqual([REF, null])
  })

  it('un id de PayPhone ajeno se alerta como posible manipulación', async () => {
    const base = baseFalsa({ claim: { result: 'mismatch', orderId: 'o1', businessId: 'b1' } })
    const { pagos, alertas } = montar({ base, payphone: payphoneFalso() })
    expect((await pagos.confirmar(REF, '6666')).resultado).toBe('no_confirmado')
    expect(alertas[0].code).toBe('tarjeta_id_ajeno')
  })

  it('si la base se cae, no lanza: alerta y queda pendiente', async () => {
    const base = baseFalsa({ claim: () => { throw new Error('conexión perdida') } })
    const { pagos, alertas } = montar({ base, payphone: payphoneFalso() })
    expect((await pagos.confirmar(REF, '9001')).resultado).toBe('pendiente')
    expect(alertas[0].code).toBe('tarjeta_error_al_confirmar')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('la tarea: ningún cobro se queda en el aire', () => {
  const cobro = (extra = {}) => ({
    id: 'p1', business_id: 'b1', order_id: 'o1', environment: 'pruebas',
    client_transaction_id: REF, provider_transaction_id: null, status: 'iniciado',
    amount_cents: 350, confirm_attempts: 0, created_at: new Date().toISOString(), ...extra,
  })

  it('⚠️ EL CLIENTE CERRÓ LA APP tras pagar: se encuentra por la referencia y se confirma', async () => {
    const payphone = payphoneFalso({
      consultar: { tipo: 'respuesta', statusCode: 3, transactionId: '9001', capturedCents: 350, currency: 'USD' },
    })
    const base = baseFalsa({ lease: [cobro()] })
    const { pagos } = montar({ base, payphone })
    const cuenta = await pagos.procesarPendientes()
    expect(cuenta.aprobado).toBe(1)
    expect(payphone.llamadas.confirmar).toEqual([{ id: '9001', ref: REF }])
  })

  it('un cobro cancelado en PayPhone se asienta como rechazado sin confirmar nada', async () => {
    const payphone = payphoneFalso({
      consultar: { tipo: 'respuesta', statusCode: 2, transactionId: '9001', capturedCents: 350, currency: 'USD' },
    })
    const base = baseFalsa({ lease: [cobro()], settle: { result: 'rejected' } })
    const { pagos } = montar({ base, payphone })
    expect((await pagos.procesarPendientes()).rechazado).toBe(1)
    expect(payphone.llamadas.confirmar).toHaveLength(0)
  })

  it('nadie pagó en 11 minutos: el intento caduca', async () => {
    const hace12 = new Date(Date.now() - 12 * 60 * 1000).toISOString()
    const base = baseFalsa({ lease: [cobro({ created_at: hace12 })] })
    const { pagos } = montar({ base, payphone: payphoneFalso() })
    expect((await pagos.procesarPendientes()).caducado).toBe(1)
    expect(base.llamadas.find(l => l.nombre === 'expire').args[0]).toBe(REF)
  })

  it('el cliente sigue escribiendo su tarjeta: se espera, no se caduca', async () => {
    const base = baseFalsa({ lease: [cobro()] })
    const { pagos } = montar({ base, payphone: payphoneFalso() })
    expect((await pagos.procesarPendientes()).esperando).toBe(1)
    expect(base.llamadas.map(l => l.nombre)).not.toContain('expire')
  })

  it('lo que hay que devolver se revierte en PayPhone y se cierra', async () => {
    const payphone = payphoneFalso()
    const base = baseFalsa({ lease: [cobro({ status: 'por_devolver', provider_transaction_id: '9001' })] })
    const { pagos } = montar({ base, payphone })
    expect((await pagos.procesarPendientes()).devuelto).toBe(1)
    expect(payphone.llamadas.revertir).toEqual(['9001'])
    expect(base.llamadas.find(l => l.nombre === 'finish').args).toEqual([REF, true])
  })

  it('si PayPhone ya no deja revertir (pasadas las 20:00), se pasa a devolución A MANO con alerta', async () => {
    const payphone = payphoneFalso({ revertir: { tipo: 'fallo', definitivo: true, mensaje: 'Fuera de horario', codigo: 7 } })
    const base = baseFalsa({ lease: [cobro({ status: 'por_devolver', provider_transaction_id: '9001' })] })
    const { pagos, alertas } = montar({ base, payphone })
    expect((await pagos.procesarPendientes()).manual).toBe(1)
    expect(base.llamadas.find(l => l.nombre === 'finish').args[1]).toBe(false)
    expect(alertas[0].code).toBe('tarjeta_devolucion_manual')
  })

  it('una devolución que falla por la red se reintenta, no se rinde', async () => {
    const payphone = payphoneFalso({ revertir: { tipo: 'fallo', definitivo: false, mensaje: 'timeout', codigo: null } })
    const base = baseFalsa({ lease: [cobro({ status: 'por_devolver', provider_transaction_id: '9001' })] })
    const { pagos } = montar({ base, payphone })
    expect((await pagos.procesarPendientes()).reintentar).toBe(1)
    expect(base.llamadas.map(l => l.nombre)).not.toContain('finish')
  })

  it('un cobro de OTRO modo no se toca', async () => {
    const payphone = payphoneFalso()
    const base = baseFalsa({ lease: [cobro({ environment: 'produccion', provider_transaction_id: '9001' })] })
    const { pagos } = montar({ base, payphone })
    expect((await pagos.procesarPendientes()).otro_modo).toBe(1)
    expect(payphone.llamadas.confirmar).toHaveLength(0)
    expect(payphone.llamadas.consultar).toHaveLength(0)
  })

  it('sin PayPhone configurado no consulta ni la cola', async () => {
    const base = baseFalsa()
    const { pagos } = montar({ config: null, base, payphone: payphoneFalso() })
    await pagos.procesarPendientes()
    expect(base.llamadas).toHaveLength(0)
  })

  it('un cobro que revienta no detiene a los demás', async () => {
    const payphone = payphoneFalso()
    payphone.cliente.consultar = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ tipo: 'respuesta', statusCode: 3, transactionId: '9001', capturedCents: 350, currency: 'USD' })
    const base = baseFalsa({ lease: [cobro(), cobro({ client_transaction_id: `${REF.slice(0, -1)}1` })] })
    const { pagos } = montar({ base, payphone })
    const cuenta = await pagos.procesarPendientes()
    expect(cuenta.error).toBe(1)
    expect(cuenta.aprobado).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('lo que le llega al cliente por WhatsApp', () => {
  const negocio = { name: 'Monster Pizza' }

  it('si caduca un pedido con tarjeta, NO se le habla de un comprobante', () => {
    const texto = textoDelAviso(negocio, { order_number: 7, payment_method: 'tarjeta' }, 'expirado', null)
    expect(texto).toMatch(/No se completó el pago con tarjeta/)
    expect(texto).toMatch(/No se te cobró nada/)
    expect(texto).not.toMatch(/comprobante/)
  })

  it('la transferencia sigue contando lo del comprobante, igual que antes', () => {
    const texto = textoDelAviso(negocio, { order_number: 7, payment_method: 'transferencia' }, 'expirado', null)
    expect(texto).toMatch(/comprobante/)
  })

  it('pedido PAGADO con tarjeta y cancelado: lo primero es que su dinero vuelve', () => {
    const texto = textoDelAviso(negocio, {
      order_number: 7, payment_method: 'tarjeta', payment_confirmed_at: '2026-09-27T12:00:00Z',
    }, 'cancelado', null)
    expect(texto).toMatch(/Te devolvemos el pago de tu tarjeta/)
    const sinPagar = textoDelAviso(negocio, { order_number: 7, payment_method: 'tarjeta' }, 'cancelado', null)
    expect(sinPagar).not.toMatch(/devolvemos/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('el camino real: lo nuevo está conectado', () => {
  const tienda = fs.readFileSync('src/routes/storefront.routes.ts', 'utf8')
  const arranque = fs.readFileSync('src/index.ts', 'utf8')

  it('la tarea de cobros arranca con el servidor, dentro del freno de tareas', () => {
    const permitido = arranque.indexOf('if (tareas.permitido)')
    const tarea = arranque.indexOf('pagosConTarjeta().procesarPendientes')
    expect(permitido).toBeGreaterThan(-1)
    expect(tarea).toBeGreaterThan(permitido)
  })

  it('la vuelta de PayPhone está montada en el servidor', () => {
    expect(arranque).toMatch(/app\.use\(pagosRouter\)/)
    const retorno = require('../dist/routes/pagos.routes')
    expect(retorno.stack.map(l => l.route?.path)).toContain('/pagos/payphone/retorno')
  })

  it('con tarjeta NO se pide comprobante por el chat ni se avisa al dueño antes del cobro', () => {
    expect(tienda).toMatch(/oficial\.payment_method !== 'tarjeta'/)
    expect(tienda).toMatch(/if \(paymentMethod !== 'tarjeta'\) \{\s*void avisarAlDuenoDelPedido/)
  })

  it('⚠️ el salto a PayPhone lleva el ORIGEN, o PayPhone responde «NO AUTORIZADO»', () => {
    // Primera prueba real (2026-09-27): la app entera manda `no-referrer`, y
    // PayPhone solo acepta el pago si el navegador llega desde el dominio
    // registrado. Se manda el origen SOLO en ese salto, sin ruta ni sesión.
    const api = fs.readFileSync('../apps/store/src/lib/api.ts', 'utf8')
    const salto = api.slice(api.indexOf('export const irAPayPhone'))
    expect(salto).toMatch(/referrerPolicy = 'origin'/)
    for (const pantalla of ['FoodStore.tsx', 'PagoConTarjeta.tsx']) {
      const fuente = fs.readFileSync(`../apps/store/src/screens/${pantalla}`, 'utf8')
      expect(fuente, pantalla).toMatch(/irAPayPhone\(url\)/)
      expect(fuente, pantalla).not.toMatch(/location\.assign\(url\)/)
    }
    // Y el resto de la app sigue sin mandar Referer: la tienda puede llevar la
    // sesión en su dirección.
    const cabeceras = fs.readFileSync('src/middleware/security-headers.ts', 'utf8')
    expect(cabeceras).toMatch(/'Referrer-Policy', 'no-referrer'/)
  })

  it('pedir con tarjeta donde no se ofrece se RECHAZA, no se crea «sin método»', () => {
    const rechazo = tienda.indexOf("metodoPedido === 'tarjeta' && !tarjetaDisponible(business)")
    const creacion = tienda.indexOf('db.createStorefrontOrder(')
    expect(rechazo).toBeGreaterThan(-1)
    expect(rechazo).toBeLessThan(creacion)
  })
})
