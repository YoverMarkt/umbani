import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  analisisEncendido, crearLectorDeComprobantes, decidirSiEsComprobante,
  normalizarFecha, normalizarHora, normalizarMonto,
} from '../dist/services/receipt-vision.js'
import {
  compararConElPedido, leerReglas, mismaCuenta, mismoBeneficiario,
  nivelDeRiesgo, REGLAS_POR_DEFECTO,
} from '../dist/services/receipt-analysis.js'
import { crearRegistroDeComprobantes } from '../dist/services/receipt-ingest.js'
import {
  crearBuzonDeComprobantes, esComprobante, esComprobanteAmbiguo,
  esFotoQueNoEsComprobante, MARCA_COMPROBANTE, MARCA_COMPROBANTE_AMBIGUO,
  MARCA_NO_ES_COMPROBANTE, RESPUESTA_NO_ES_COMPROBANTE,
} from '../dist/services/payment-proof-inbox.js'

// ═══════════════════════════════════════════════════════════════════════════
// EL COMPROBANTE SE LEE Y SE PUNTÚA
//
// ⚠️ LO QUE ESTE ARCHIVO PROTEGE POR ENCIMA DE TODO: que analizar NO confirme
// un pago, y que un falso negativo no deje tirado a quien sí pagó.
// ═══════════════════════════════════════════════════════════════════════════

const leer = ruta => readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), 'utf8')

// ───────────────────────────────────────────────────────────────────────────
describe('el interruptor nace APAGADO', () => {
  // Fusionar despliega producción sola. Si el análisis naciera encendido, el
  // primer cliente real sería el conejillo de indias — y es lo único de la
  // plataforma que puede negarle algo a alguien que ya pagó.
  it('sin ajuste escrito, está apagado', () => {
    for (const valor of [null, undefined, '', '   ', '0', 'false', 'no', 'apagado']) {
      expect(analisisEncendido(valor), `${JSON.stringify(valor)} no puede encenderlo`).toBe(false)
    }
  })

  it('solo un valor afirmativo explícito lo enciende', () => {
    for (const valor of ['1', 'true', 'si', 'sí', 'on', 'TRUE', ' 1 ']) {
      expect(analisisEncendido(valor), `${valor} debería encenderlo`).toBe(true)
    }
  })

  it('apagado NO llama al modelo ni pide la credencial', async () => {
    const get = vi.fn(async () => null)
    const crearCliente = vi.fn()
    const leerImagen = crearLectorDeComprobantes({ settings: { get }, crearCliente })

    expect(await leerImagen(Buffer.from('x'))).toEqual({ ok: false, motivo: 'apagado' })
    expect(crearCliente).not.toHaveBeenCalled()
    // Se pregunta por el interruptor y se para ahí: ni siquiera se lee la key.
    expect(get).toHaveBeenCalledWith('receipt_analysis_enabled')
    expect(get).not.toHaveBeenCalledWith('openai_api_key')
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('la portería: ¿esto es siquiera un comprobante?', () => {
  const senales = extra => ({ banco: false, monto: false, fecha: false, referencia: false, ...extra })

  it('sin NINGUNA señal y con el modelo diciendo que no, se rechaza', () => {
    expect(decidirSiEsComprobante(false, senales())).toBe(false)
  })

  // ⚠️ LA ASIMETRÍA, que es el núcleo del módulo. Los dos errores no cuestan
  // lo mismo: rechazar a quien pagó lo deja tirado; aceptar una foto de un
  // perro solo le hace sonreír al dueño — y es lo que pasaba hasta hoy.
  it('CUALQUIER señal suelta basta para tratarlo como comprobante', () => {
    for (const senal of ['banco', 'monto', 'fecha', 'referencia']) {
      expect(
        decidirSiEsComprobante(false, senales({ [senal]: true })),
        `con ${senal} a la vista NO se puede rechazar`,
      ).toBe(true)
    }
  })

  it('ante un campo ausente o raro se prefiere tratarlo como comprobante', () => {
    for (const dijo of [undefined, null, 'quizá', 0, '']) {
      expect(decidirSiEsComprobante(dijo, senales())).toBe(true)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('normalizar lo que devuelve el modelo', () => {
  // ⚠️ Ecuador escribe dd/mm/aaaa. Leerlo al revés cambiaría el mes y el día
  // de medio año de comprobantes sin que nada avisara.
  it('«08/09/2026» es 8 de septiembre, no 9 de agosto', () => {
    expect(normalizarFecha('08/09/2026')).toBe('2026-09-08')
    expect(normalizarFecha('22-08-2026')).toBe('2026-08-22')
    expect(normalizarFecha('2026-08-22')).toBe('2026-08-22')
  })

  it('una fecha imposible se queda nula en vez de colarse', () => {
    // El 31 de febrero: `new Date` lo desplaza a marzo EN SILENCIO.
    expect(normalizarFecha('31/02/2026')).toBeNull()
    expect(normalizarFecha('32/13/2026')).toBeNull()
    expect(normalizarFecha('ayer')).toBeNull()
    expect(normalizarFecha('1899-01-01')).toBeNull()
    expect(normalizarFecha(null)).toBeNull()
  })

  it('la hora se normaliza a 24 h', () => {
    expect(normalizarHora('14:35')).toBe('14:35')
    expect(normalizarHora('2:05 pm')).toBe('14:05')
    expect(normalizarHora('12:30 am')).toBe('00:30')
    expect(normalizarHora('25:99')).toBeNull()
    expect(normalizarHora('ayer')).toBeNull()
  })

  // ⚠️ `Number(null)` es 0, no NaN. Es el mismo fallo que ya cazaron
  // `accuracy_m` y la latitud de las ubicaciones — y aquí sería peor: un cero
  // colado parecería un comprobante de $0 que no cuadra, y dispararía la
  // alarma de «pagó de menos» sobre un pago que nadie llegó a leer.
  it('un monto nulo NO se convierte en cero', () => {
    expect(normalizarMonto(null)).toBeNull()
    expect(normalizarMonto(undefined)).toBeNull()
    expect(normalizarMonto('')).toBeNull()
    expect(normalizarMonto('un millón de dólares')).toBeNull()
  })

  it('entiende las dos formas de escribir una cifra', () => {
    expect(normalizarMonto('20.50')).toBe('20.50')
    expect(normalizarMonto('$1,234.56')).toBe('1234.56')
    expect(normalizarMonto('USD 1.234,56')).toBe('1234.56')
    expect(normalizarMonto('1,50')).toBe('1.50')
    expect(normalizarMonto(20)).toBe('20.00')
  })

  it('un monto fuera del rango de la tabla se descarta', () => {
    // El CHECK admite 0..999999: pasarlo abortaría la escritura entera.
    expect(normalizarMonto('9999999')).toBeNull()
    expect(normalizarMonto('-5')).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('el lector, cuando algo va mal', () => {
  const montar = (respuesta, opciones = {}) => crearLectorDeComprobantes({
    settings: {
      get: async clave => (clave === 'receipt_analysis_enabled' ? '1' : 'sk-test'),
    },
    crearCliente: () => ({
      chat: {
        completions: {
          create: opciones.lanza
            ? async () => { throw new Error('OpenAI 503') }
            : async () => ({ choices: [{ message: { content: respuesta } }] }),
        },
      },
    }),
    logger: { log: () => {} },
  })

  it('si OpenAI revienta, NUNCA lanza: falla abierto', async () => {
    expect(await montar(null, { lanza: true })(Buffer.from('x')))
      .toEqual({ ok: false, motivo: 'fallo_del_modelo' })
  })

  it('si devuelve algo que no es JSON, tampoco lanza', async () => {
    expect(await montar('lo siento, no puedo')(Buffer.from('x')))
      .toEqual({ ok: false, motivo: 'json_invalido' })
  })

  it('si devuelve un array en vez de un objeto, tampoco', async () => {
    expect((await montar('[1,2,3]')(Buffer.from('x'))).ok).toBe(false)
  })

  it('sin credencial no llama a nadie', async () => {
    const leerImagen = crearLectorDeComprobantes({
      settings: { get: async c => (c === 'receipt_analysis_enabled' ? '1' : null) },
      crearCliente: () => { throw new Error('no debería crearse el cliente') },
    })
    expect(await leerImagen(Buffer.from('x'))).toEqual({ ok: false, motivo: 'sin_credencial' })
  })

  it('lee y sanea una respuesta buena', async () => {
    const leerImagen = montar(JSON.stringify({
      es_comprobante: true,
      senales: { banco: true, monto: true, fecha: true, referencia: true },
      bank_name: '  Banco Pichincha  ',
      amount: '$20.00',
      transaction_date: '22/08/2026',
      transaction_time: '2:35 pm',
      reference_number: 'REF-1',
      // Los modelos rellenan lo que no saben con esto: no es un dato leído.
      sender_name: 'no visible',
    }))
    const resultado = await leerImagen(Buffer.from('x'), 'image/png')
    expect(resultado.ok).toBe(true)
    expect(resultado.esComprobante).toBe(true)
    expect(resultado.datos).toMatchObject({
      bank_name: 'Banco Pichincha',
      amount: '20.00',
      transaction_date: '2026-08-22',
      transaction_time: '14:35',
      reference_number: 'REF-1',
    })
    expect(resultado.datos.sender_name).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('comparar con el pedido', () => {
  const pedido = { total: 20, currency: 'USD', createdAt: '2026-08-22T14:00:00Z', cuenta: {
    bank_name: 'Banco Pichincha', account_number: '2100123456', holder_name: 'Monster Pizza',
  } }
  const tipos = senales => senales.map(s => s.flag_type)

  it('el monto justo tranquiliza y RESTA', () => {
    const senales = compararConElPedido(
      { amount: '20.00', bank_name: 'Pichincha', reference_number: 'R1', destination_account: '2100123456' },
      pedido,
    )
    expect(tipos(senales)).toContain('monto_coincide')
    expect(senales.find(s => s.flag_type === 'monto_coincide').points).toBeLessThan(0)
  })

  // ⚠️ Pagar de MENOS es el error que le cuesta dinero al negocio, y el caso
  // típico de reenviar el comprobante de otro pedido más barato.
  it('pagar de menos pesa MÁS que pagar de más', () => {
    const menos = compararConElPedido({ amount: '15.00' }, pedido)
      .find(s => s.flag_type === 'monto_menor')
    const mas = compararConElPedido({ amount: '25.00' }, pedido)
      .find(s => s.flag_type === 'monto_mayor')
    expect(menos.points).toBeGreaterThan(mas.points)
    expect(menos.description).toContain('faltan $5.00')
  })

  it('la cuenta ajena es la señal más grave que puede dar la lectura', () => {
    const senales = compararConElPedido({ destination_account: '9999888877' }, pedido)
    const cuenta = senales.find(s => s.flag_type === 'cuenta_incorrecta')
    expect(cuenta.severity).toBe('critica')
    expect(cuenta.points).toBe(REGLAS_POR_DEFECTO.cuenta_incorrecta)
  })

  it('un comprobante de hace días se marca como viejo', () => {
    const senales = compararConElPedido({ transaction_date: '2026-08-10' }, pedido)
    expect(tipos(senales)).toContain('fecha_antigua')
  })

  it('una fecha posterior al pedido no existe', () => {
    const senales = compararConElPedido({ transaction_date: '2026-09-01' }, pedido)
    expect(tipos(senales)).toContain('fecha_futura')
  })

  it('una regla en CERO apaga su señal, no la escribe con cero puntos', () => {
    // Sin esto, apagar una regla desde Ajustes llenaría el panel de señales
    // que no significan nada.
    const senales = compararConElPedido(
      { amount: '20.00' },
      pedido,
      { ...REGLAS_POR_DEFECTO, monto_coincide: 0, sin_banco: 0, sin_referencia: 0 },
    )
    expect(tipos(senales)).not.toContain('monto_coincide')
    expect(tipos(senales)).not.toContain('sin_banco')
  })

  it('una moneda distinta se marca', () => {
    const senales = compararConElPedido({ currency: 'EUR' }, pedido)
    expect(tipos(senales)).toContain('moneda_distinta')
    // Y la misma moneda escrita de otra forma NO es una señal.
    expect(tipos(compararConElPedido({ currency: 'usd' }, pedido)))
      .not.toContain('moneda_distinta')
  })

  it('el beneficiario que cuadra tranquiliza', () => {
    const senales = compararConElPedido({ beneficiary_name: 'MONSTER PIZZA' }, pedido)
    const senal = senales.find(s => s.flag_type === 'beneficiario_coincide')
    expect(senal.points).toBeLessThan(0)
  })

  // ⚠️ Que el beneficiario NO cuadre no es señal propia: el titular legal y el
  // nombre comercial casi nunca se escriben igual, y marcarlo llenaría de rojo
  // los pagos buenos. La CUENTA es lo que identifica el destino de verdad.
  it('un beneficiario distinto NO se marca como riesgo', () => {
    const senales = compararConElPedido({ beneficiary_name: 'Otra Empresa SA' }, pedido)
    expect(tipos(senales)).not.toContain('beneficiario_incorrecto')
    expect(tipos(senales)).not.toContain('beneficiario_no_coincide')
  })

  it('lo que falta en la imagen también se dice', () => {
    const senales = compararConElPedido({}, pedido)
    expect(tipos(senales)).toEqual(
      expect.arrayContaining(['sin_fecha', 'sin_referencia', 'sin_banco']),
    )
  })

  it('dentro de los días de gracia NO se marca como viejo', () => {
    // El pedido es del 22; un comprobante del 21 es normal (se transfirió la
    // noche anterior). El margen sale de las reglas, no de un número suelto.
    expect(tipos(compararConElPedido({ transaction_date: '2026-08-21' }, pedido)))
      .not.toContain('fecha_antigua')
    expect(tipos(compararConElPedido(
      { transaction_date: '2026-08-21' },
      pedido,
      { ...REGLAS_POR_DEFECTO, dias_de_gracia: 0 },
    ))).toContain('fecha_antigua')
  })

  it('sin fecha de pedido no se inventa una comparación de fechas', () => {
    const senales = compararConElPedido(
      { transaction_date: '2020-01-01' },
      { total: 20, cuenta: null },
    )
    expect(tipos(senales)).not.toContain('fecha_antigua')
    expect(tipos(senales)).not.toContain('fecha_futura')
  })

  it('sin cuenta publicada no se acusa de cuenta incorrecta', () => {
    // Un negocio que aún no cargó sus datos bancarios no puede salir en rojo
    // en todos sus pedidos.
    const senales = compararConElPedido(
      { destination_account: '9999888877' },
      { total: 20, cuenta: null },
    )
    expect(tipos(senales)).not.toContain('cuenta_incorrecta')
    expect(tipos(senales)).not.toContain('cuenta_coincide')
  })

  it('sin monto leído no se inventa una señal de monto', () => {
    const senales = compararConElPedido({ amount: null }, pedido)
    expect(tipos(senales)).not.toContain('monto_menor')
    expect(tipos(senales)).not.toContain('monto_coincide')
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('las comparaciones que no son literales', () => {
  // ⚠️ Los bancos ENMASCARAN la cuenta. Comparando cadenas enteras, la señal
  // más grave del motor saltaría en TODOS los pagos buenos.
  it('la cuenta enmascarada se reconoce por los últimos cuatro dígitos', () => {
    expect(mismaCuenta('****3456', '2100123456')).toBe(true)
    expect(mismaCuenta('22•••••56', '2100123456')).toBe(false)
    expect(mismaCuenta('2100123456', '2100123456')).toBe(true)
    expect(mismaCuenta('9999888877', '2100123456')).toBe(false)
  })

  it('sin uno de los dos datos NO se acusa a nadie: es «no se sabe»', () => {
    expect(mismaCuenta(null, '2100123456')).toBeNull()
    expect(mismaCuenta('2100123456', '')).toBeNull()
    expect(mismaCuenta('12', '2100123456')).toBeNull()
  })

  it('el beneficiario se compara sin tildes y por palabras', () => {
    expect(mismoBeneficiario('MONSTER PIZZA', 'Monster Pizza')).toBe(true)
    expect(mismoBeneficiario('Juan Pérez Loor', 'JUAN PEREZ')).toBe(true)
    expect(mismoBeneficiario('Otra Empresa SA', 'Monster Pizza')).toBe(false)
    expect(mismoBeneficiario(null, 'Monster Pizza')).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('las reglas se configuran sin desplegar', () => {
  it('un JSON roto NO deja el motor sin reglas', () => {
    expect(leerReglas('{esto no es json')).toEqual(REGLAS_POR_DEFECTO)
    expect(leerReglas(null)).toEqual(REGLAS_POR_DEFECTO)
    expect(leerReglas('[1,2,3]')).toEqual(REGLAS_POR_DEFECTO)
  })

  it('lo que llega bien manda, y lo que llega mal se ignora', () => {
    const reglas = leerReglas(JSON.stringify({
      monto_menor: 90,
      cuenta_incorrecta: 'mucho',      // no es número
      sin_banco: 999,                  // fuera de rango
      inventada: 50,                   // no existe
    }))
    expect(reglas.monto_menor).toBe(90)
    expect(reglas.cuenta_incorrecta).toBe(REGLAS_POR_DEFECTO.cuenta_incorrecta)
    expect(reglas.sin_banco).toBe(REGLAS_POR_DEFECTO.sin_banco)
    expect(reglas.inventada).toBeUndefined()
  })

  it('las bandas del nivel son las mismas que deriva PostgreSQL', () => {
    expect(nivelDeRiesgo(0)).toBe('bajo')
    expect(nivelDeRiesgo(20)).toBe('bajo')
    expect(nivelDeRiesgo(21)).toBe('medio')
    expect(nivelDeRiesgo(50)).toBe('medio')
    expect(nivelDeRiesgo(51)).toBe('alto')
    expect(nivelDeRiesgo(75)).toBe('alto')
    expect(nivelDeRiesgo(76)).toBe('critico')
    expect(nivelDeRiesgo(100)).toBe('critico')
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('guardar el análisis: los tres desenlaces', () => {
  const armar = () => {
    const saveReceiptAnalysis = vi.fn(async () => ({ error: null }))
    const registrar = crearRegistroDeComprobantes({
      database: {
        registerPaymentReceipt: async () => ({
          data: { result: 'registered', receipt_id: 'r1', duplicado: false },
        }),
        saveReceiptAnalysis,
        getBusinessBankAccount: async () => ({ account_number: '2100123456' }),
      },
      settings: { get: async () => null },
      logger: { log: () => {} },
    })
    return { registrar, saveReceiptAnalysis }
  }
  const base = {
    businessId: 'biz-1', orderId: 'ped-1', imagen: Buffer.from('x'),
    fileUrl: 'https://x/1', esperado: { total: 20 },
  }

  it('APAGADO: no se escribe nada, se queda en pendiente_analisis', async () => {
    const { registrar, saveReceiptAnalysis } = armar()
    await registrar({ ...base, analisis: { ok: false, motivo: 'apagado' } })
    expect(saveReceiptAnalysis).not.toHaveBeenCalled()
  })

  it('sin análisis ninguno, tampoco: es el camino de siempre', async () => {
    const { registrar, saveReceiptAnalysis } = armar()
    await registrar(base)
    expect(saveReceiptAnalysis).not.toHaveBeenCalled()
  })

  // ⚠️ Encendido pero fallido NO es lo mismo que apagado: el dueño tiene que
  // saber que ese comprobante no lleva señales porque nadie las buscó, no
  // porque estuviera limpio.
  it('FALLIDO: queda en requiere_revision, sin acusar a nadie', async () => {
    const { registrar, saveReceiptAnalysis } = armar()
    await registrar({ ...base, analisis: { ok: false, motivo: 'fallo_del_modelo' } })
    const llamada = saveReceiptAnalysis.mock.calls[0][0]
    expect(llamada.status).toBe('requiere_revision')
    expect(llamada.flags[0].flag_type).toBe('ilegible')
  })

  it('LEÍDO: se guardan los campos y las señales', async () => {
    const { registrar, saveReceiptAnalysis } = armar()
    await registrar({
      ...base,
      analisis: {
        ok: true, esComprobante: true,
        senales: { banco: true, monto: true, fecha: true, referencia: true },
        datos: {
          amount: '15.00', bank_name: 'Pichincha',
          reference_number: 'R1', destination_account: '2100123456',
        },
        crudo: { modelo: 'gpt-4o-mini' },
      },
    })
    const llamada = saveReceiptAnalysis.mock.calls[0][0]
    expect(llamada.status).toBe('analizado')
    expect(llamada.datos.bank_name).toBe('Pichincha')
    // Pagó 15 de un pedido de 20: tiene que salir la señal.
    expect(llamada.flags.map(f => f.flag_type)).toContain('monto_menor')
  })

  it('un fallo guardando el análisis NO tumba la huella', async () => {
    const registrar = crearRegistroDeComprobantes({
      database: {
        registerPaymentReceipt: async () => ({
          data: { result: 'registered', receipt_id: 'r1', duplicado: true, duplicado_exacto: true },
        }),
        saveReceiptAnalysis: async () => { throw new Error('la base se cayó') },
      },
      logger: { log: () => {} },
    })
    const huella = await registrar({ ...base, analisis: { ok: false, motivo: 'x' } })
    // La huella se registró y el duplicado quedó marcado igual.
    expect(huella.registrado).toBe(true)
    expect(huella.duplicadoExacto).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('LA COMPUERTA: la foto que no es un comprobante', () => {
  const montar = (analizarImagen) => {
    const subirPrivado = vi.fn(async () => ({ url: 'https://x/1', public_id: 'p1', phash: 'ph' }))
    const adjuntar = vi.fn(async () => ({ data: {}, error: null }))
    const registrarHuella = vi.fn(async () => ({}))
    const buzon = crearBuzonDeComprobantes({
      pedidosEsperando: async () => ([{
        id: 'ped-1', business_id: 'biz-1', order_number: 45,
        contact_phone: '593990000001', total: 20, created_at: '2026-08-22T14:00:00Z',
      }]),
      analizarImagen,
      subirPrivado,
      adjuntar,
      registrarHuella,
      registrarError: async () => {},
    })
    return { buzon, subirPrivado, adjuntar, registrarHuella }
  }
  const foto = Buffer.from('una foto')

  it('una foto SIN nada de un pago no se sube ni se adjunta', async () => {
    const { buzon, subirPrivado, adjuntar } = montar(async () => ({
      ok: true, esComprobante: false,
      senales: { banco: false, monto: false, fecha: false, referencia: false },
      datos: {}, crudo: {},
    }))
    const resultado = await buzon('biz-1', '593990000001', foto, 'image/jpeg')

    expect(resultado).toEqual({ adjuntado: false, noEsComprobante: true })
    // ⚠️ Ni un byte a Cloudinary: el negocio no paga almacenamiento por la
    // foto de un perro. Y el pedido NO se mueve a `pago_en_revision`, así que
    // al dueño no le suena la alarma por nada.
    expect(subirPrivado).not.toHaveBeenCalled()
    expect(adjuntar).not.toHaveBeenCalled()
  })

  // ⚠️ TODAS las formas de fallar tienen que acabar adjuntando. Un falso
  // negativo deja tirado a alguien que acaba de transferir de verdad.
  it('FALLA ABIERTO: sin analizador, apagado, caído o con dudas, se adjunta', async () => {
    const casos = {
      'sin analizador': undefined,
      'apagado': async () => ({ ok: false, motivo: 'apagado' }),
      'OpenAI caído': async () => ({ ok: false, motivo: 'fallo_del_modelo' }),
      'el analizador lanza': async () => { throw new Error('boom') },
      'una señal suelta': async () => ({
        ok: true, esComprobante: true,
        senales: { banco: false, monto: true, fecha: false, referencia: false },
        datos: {}, crudo: {},
      }),
    }
    for (const [nombre, analizador] of Object.entries(casos)) {
      const { buzon, adjuntar } = montar(analizador)
      const resultado = await buzon('biz-1', '593990000001', foto, 'image/jpeg')
      expect(resultado.adjuntado, `«${nombre}» tiene que adjuntar igual`).toBe(true)
      expect(adjuntar).toHaveBeenCalled()
    }
  })

  it('lo leído viaja a la huella: no se paga dos veces por la misma imagen', async () => {
    const analisis = {
      ok: true, esComprobante: true,
      senales: { banco: true, monto: true, fecha: true, referencia: true },
      datos: { amount: '20.00' }, crudo: {},
    }
    const { buzon, registrarHuella } = montar(async () => analisis)
    await buzon('biz-1', '593990000001', foto, 'image/jpeg')

    expect(registrarHuella).toHaveBeenCalledWith(expect.objectContaining({
      analisis,
      // ⚠️ `clienteNombre` viaja desde el 2026-09-01: es con lo que se compara
      // el ORDENANTE. Que no coincida no rechaza —pagar desde la cuenta de la
      // pareja es normal— pero el dueño tiene que verlo marcado.
      esperado: {
        total: 20, createdAt: '2026-08-22T14:00:00Z', clienteNombre: null,
      },
    }))
  })

  it('el tipo de la imagen llega al analizador', async () => {
    const analizar = vi.fn(async () => ({ ok: false, motivo: 'apagado' }))
    const { buzon } = montar(analizar)
    await buzon('biz-1', '593990000001', foto, 'image/png')
    expect(analizar).toHaveBeenCalledWith(foto, 'image/png')
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('los marcadores no se confunden entre ellos', () => {
  // ⚠️ Confundirlos le diría al cliente que su pago quedó registrado cuando
  // no lo está. Ya hubo una prueba así para los dos primeros; este es el
  // tercero y entra en la misma malla.
  it('cada marcador solo lo reconoce el suyo', () => {
    const textos = {
      comprobante: `[el cliente envió ${MARCA_COMPROBANTE} del pedido #45]`,
      ambiguo: `[el cliente envió ${MARCA_COMPROBANTE_AMBIGUO}: El Puerto / Monster Pizza]`,
      noEs: `[el cliente envió ${MARCA_NO_ES_COMPROBANTE}]`,
    }
    expect(esComprobante(textos.comprobante)).toBe(true)
    expect(esComprobante(textos.ambiguo)).toBe(false)
    expect(esComprobante(textos.noEs)).toBe(false)

    expect(esComprobanteAmbiguo(textos.ambiguo)).toBe(true)
    expect(esComprobanteAmbiguo(textos.noEs)).toBe(false)

    expect(esFotoQueNoEsComprobante(textos.noEs)).toBe(true)
    expect(esFotoQueNoEsComprobante(textos.comprobante)).toBe(false)
    expect(esFotoQueNoEsComprobante(textos.ambiguo)).toBe(false)
  })

  it('la respuesta dice QUÉ tiene que verse, no solo que está mal', () => {
    // Sin esto, la segunda foto sale tan inservible como la primera — y cada
    // mensaje se paga desde el 1 de octubre.
    for (const dato of ['valor', 'fecha', 'referencia']) {
      expect(RESPUESTA_NO_ES_COMPROBANTE.toLowerCase()).toContain(dato)
    }
    // Y no acusa a nadie: pudo ser una foto mandada por error.
    expect(RESPUESTA_NO_ES_COMPROBANTE).not.toMatch(/fraude|falso|mentira/i)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('la migración protege lo que importa', () => {
  const sql = leer('../migration-2026-08-22-lectura-del-comprobante.sql')
  const codigo = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

  // ⚠️ LA REGLA QUE NO SE NEGOCIA. Un modelo mirando una foto no puede dar
  // por cobrado un pedido: eso lo decide el dueño mirando su banco.
  it('NADA de esto confirma un pago ni mueve un pedido', () => {
    expect(codigo).not.toMatch(/payment_confirmed_at\s*=/)
    expect(codigo).not.toMatch(/update\s+public\.orders/i)
    expect(codigo).not.toMatch(/insert\s+into\s+public\.sales/i)
  })

  it('los únicos estados que escribe son los dos que no dicen «pagado»', () => {
    expect(codigo).toContain("not in ('analizado', 'requiere_revision')")
  })

  it('no recrea las funciones del dinero', () => {
    for (const funcion of [
      'create_storefront_order', 'set_order_status', 'attach_storefront_payment_proof',
      'register_payment_receipt',
    ]) {
      expect(codigo, `${funcion} no se puede recrear aquí`).not.toContain(`function public.${funcion}`)
    }
  })

  it('ni el dueño ni el cliente pueden llamarlas: solo el servidor', () => {
    for (const funcion of ['save_receipt_analysis', 'get_receipt_analysis']) {
      expect(codigo).toMatch(
        new RegExp(`revoke all on function public\\.${funcion}[\\s\\S]{0,120}from public, anon, authenticated`),
      )
      expect(codigo).toMatch(
        new RegExp(`grant execute on function public\\.${funcion}[\\s\\S]{0,120}to service_role`),
      )
    }
  })

  it('la lectura del panel filtra SIEMPRE por negocio', () => {
    // El identificador del pedido viaja en la URL: sin el negocio se estaría
    // enseñando el comprobante de otro local.
    const lectura = codigo.slice(codigo.indexOf('function public.get_receipt_analysis'))
    expect(lectura).toContain('r.business_id = p_business_id')
    expect(lectura).toContain('f.business_id = p_business_id')
  })

  // ⚠️ El nombre no es decorativo: el ejecutor ordena alfabéticamente y esta
  // migración DEPENDE de la de la huella. Es la tercera vez que la trampa
  // aparece, y el CI no puede verla.
  it('el archivo explica por qué se llama «lectura» y no «analisis»', () => {
    expect(sql).toMatch(/ordena alfabéticamente|localeCompare/i)
    expect(sql).toContain('huella-del-comprobante')
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('el panel del dueño', () => {
  // Pedidos ENTERO: desde el 2026-10-08 la página, la tarjeta del pedido y el
  // análisis viven en archivos aparte (ningún archivo pasa de 1.000 líneas).
  // Leyendo solo `Orders.tsx`, la prueba del aviso pasaba en VACÍO: no
  // encontraba el aviso y comprobaba un trozo vacío.
  const panel = ['AnalisisDelComprobante.tsx', 'Orders.tsx', 'TarjetaPedido.tsx', 'formato.ts']
    .map(archivo => leer(`../../apps/client/src/features/orders/${archivo}`)).join('\n')

  // ⚠️ El aviso va SIEMPRE. Es la diferencia entre una herramienta que ayuda
  // a decidir y una que decide por el dueño.
  it('avisa SIEMPRE de que esto no confirma que el dinero haya entrado', () => {
    expect(panel).toContain('no confirma que el dinero haya ingresado')
    expect(panel).toContain('Verifica el movimiento bancario antes de aprobar')
  })

  it('el aviso NO está dentro de una condición del riesgo', () => {
    // Si colgara del score, un comprobante «limpio» se aprobaría sin leerlo.
    const aviso = panel.indexOf('TriangleAlert className')
    expect(aviso, 'no encuentro el aviso: esta prueba miraría la nada').toBeGreaterThan(-1)
    expect(panel.slice(aviso, aviso + 400)).not.toMatch(/risk_level|risk_score/)
  })

  // ⚠️ El panel recarga sus pedidos cada 12 s. Colgar el análisis de ese
  // refresco sería una consulta por pedido y por minuto durante todo el
  // servicio, para leer siempre lo mismo: no cambia una vez escrito.
  it('el análisis no se recarga con el refresco de la lista', () => {
    expect(panel).toContain('staleTime: Infinity')
  })

  it('los tres botones del pago siguen ahí', () => {
    expect(panel).toContain('Solo confirmar el pago')
    expect(panel).toContain('Pedir otro comprobante')
    expect(panel).toContain('Rechazar el pago')
  })
})
