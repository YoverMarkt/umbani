// ═══════════════════════════════════════════════════════════════════════════
// LOS PROVEEDORES FALSOS: PAYPHONE Y WHATSAPP, DENTRO DE LA PRUEBA
// ═══════════════════════════════════════════════════════════════════════════
//
// El servidor bajo prueba cree que habla con PayPhone y con YCloud, y habla con
// esto (lo desvía `interceptor.cjs`). Contesta con la MISMA forma que los de
// verdad —la que lee `integrations/payphone.ts`— y anota todo lo que recibe.
//
// Las pruebas lo manejan por `/__control/*`, porque corren en otro proceso:
//   · `pagar`     → «el cliente escribió su tarjeta en PayPhone» (aprobada o no)
//   · `estado`    → qué se preparó, qué se confirmó, qué se devolvió, qué
//                   mensajes de WhatsApp salieron y a quién.
//   · `reiniciar` → vacía lo anotado entre pruebas.
//
// ⚠️ PayPhone de verdad tiene una regla que este falso respeta a propósito:
// `Confirm` es lo que CAPTURA el dinero. Un cobro pagado y sin confirmar no es
// un cobro —el de verdad lo devuelve solo a los cinco minutos—. Por eso
// `confirmadas` y `pagadas` se anotan por separado: una prueba que solo mire
// «pagó» no sabe si el servidor capturó.

import http from 'node:http'

const PAYPHONE = 'pay.payphonetodoesposible.com'
const YCLOUD = 'api.ycloud.com'
// El correo de los códigos para entrar a las apps (2026-10-06).
const RESEND = 'api.resend.com'

export function crearProveedoresFalsos() {
  let siguienteId = 900001
  const estado = {
    /** Lo que el servidor preparó: { id, referencia, centavos, cuerpo } */
    preparadas: [],
    /** Lo que el «cliente» pagó en la página de PayPhone, por referencia. */
    pagadas: new Map(),
    /** Los `Confirm` que llegaron: { id, referencia } */
    confirmadas: [],
    /** Los `Reverse` que llegaron: { id } */
    revertidas: [],
    /** Los mensajes de WhatsApp que salieron: { to, tipo, texto } */
    mensajes: [],
    /** Los correos que salieron: { para, asunto, texto } */
    correos: [],
    /** Cualquier llamada a un proveedor sin falso: delata una puerta abierta. */
    desconocidas: [],
  }

  const reiniciar = () => {
    estado.preparadas = []
    estado.pagadas = new Map()
    estado.confirmadas = []
    estado.revertidas = []
    estado.mensajes = []
    estado.correos = []
    estado.desconocidas = []
  }

  /** La forma exacta de la respuesta de `Confirm` y de la consulta. */
  const cobroDe = (preparada) => {
    const pago = estado.pagadas.get(preparada.referencia)
    if (!pago) {
      // Nadie escribió la tarjeta todavía: PayPhone la tiene «pendiente».
      return { statusCode: 1, transactionId: preparada.id, amount: preparada.centavos, currency: 'USD', transactionStatus: 'Pending' }
    }
    return {
      statusCode: pago.aprobado ? 3 : 2,
      transactionId: preparada.id,
      // PayPhone puede capturar OTRO monto: el servidor tiene que darse cuenta.
      amount: pago.centavos ?? preparada.centavos,
      currency: 'USD',
      authorizationCode: pago.aprobado ? 'AUT123' : null,
      cardBrand: 'Visa Prueba',
      lastDigits: '4242',
      transactionStatus: pago.aprobado ? 'Approved' : 'Canceled',
      // Lo que manda PayPhone y el servidor NUNCA debe guardar ni registrar.
      email: 'titular@correo.de.prueba',
      phoneNumber: '0999999999',
      document: '0102030405',
    }
  }

  const responder = (res, codigo, cuerpo) => {
    res.writeHead(codigo, { 'content-type': 'application/json' })
    res.end(JSON.stringify(cuerpo))
  }

  const leerCuerpo = req => new Promise((resolve) => {
    let datos = ''
    req.on('data', trozo => { datos += trozo })
    req.on('end', () => {
      try {
        resolve(datos ? JSON.parse(datos) : {})
      } catch {
        resolve({ crudo: datos })
      }
    })
  })

  async function payphone(req, res, ruta, cuerpo) {
    if (req.method === 'POST' && ruta === '/api/button/Prepare') {
      const id = siguienteId++
      const preparada = { id, referencia: cuerpo.clientTransactionId, centavos: cuerpo.amount, cuerpo }
      estado.preparadas.push(preparada)
      return responder(res, 200, {
        paymentId: id,
        payWithCard: `https://${PAYPHONE}/PayPhone/Index?paymentId=${id}`,
        payWithPayPhone: `https://${PAYPHONE}/PayPhone/Index?paymentId=${id}&payphone=1`,
      })
    }
    if (req.method === 'POST' && ruta === '/api/button/V2/Confirm') {
      const preparada = estado.preparadas.find(p => p.id === Number(cuerpo.id) && p.referencia === cuerpo.clientTxId)
      if (!preparada) return responder(res, 404, { message: 'La transacción no existe', errorCode: 20 })
      estado.confirmadas.push({ id: preparada.id, referencia: preparada.referencia })
      return responder(res, 200, cobroDe(preparada))
    }
    const consulta = ruta.match(/^\/api\/Sale\/client\/(.+)$/)
    if (req.method === 'GET' && consulta) {
      const referencia = decodeURIComponent(consulta[1])
      const preparada = estado.preparadas.filter(p => p.referencia === referencia).at(-1)
      if (!preparada || !estado.pagadas.has(referencia)) {
        // Prepare sin pago no deja rastro en PayPhone (los «caducado» del sandbox).
        return responder(res, 404, { message: 'La transacción no existe', errorCode: 20 })
      }
      // La consulta NO captura: confirmar sigue siendo cosa de `Confirm`.
      return responder(res, 200, [cobroDe(preparada)])
    }
    if (req.method === 'POST' && ruta === '/api/Reverse') {
      estado.revertidas.push({ id: Number(cuerpo.id) })
      return responder(res, 200, true)
    }
    estado.desconocidas.push(`${req.method} ${PAYPHONE}${ruta}`)
    return responder(res, 404, { message: 'Ruta de PayPhone sin falso' })
  }

  async function ycloud(req, res, ruta, cuerpo) {
    if (req.method === 'POST' && /^\/v2\/whatsapp\/messages(\/sendDirectly)?$/.test(ruta)) {
      estado.mensajes.push({
        to: String(cuerpo.to || ''),
        tipo: cuerpo.type,
        texto: cuerpo.text?.body
          || cuerpo.interactive?.body?.text
          || cuerpo.template?.name
          || '',
      })
      return responder(res, 200, { id: `msg-falso-${estado.mensajes.length}`, status: 'accepted' })
    }
    // Marcar como leído, «escribiendo…», consultas de estado: aceptar y callar.
    return responder(res, 200, {})
  }

  async function resend(req, res, ruta, cuerpo) {
    if (req.method === 'POST' && ruta === '/emails') {
      estado.correos.push({
        para: Array.isArray(cuerpo.to) ? cuerpo.to.join(',') : String(cuerpo.to || ''),
        asunto: String(cuerpo.subject || ''),
        texto: String(cuerpo.text || ''),
      })
      return responder(res, 200, { id: `correo-falso-${estado.correos.length}` })
    }
    estado.desconocidas.push(`${req.method} ${RESEND}${ruta}`)
    return responder(res, 404, { message: 'Ruta de Resend sin falso' })
  }

  async function control(req, res, ruta, cuerpo) {
    if (ruta === '/__control/pagar') {
      estado.pagadas.set(cuerpo.referencia, { aprobado: cuerpo.aprobado !== false, centavos: cuerpo.centavos })
      const preparada = estado.preparadas.filter(p => p.referencia === cuerpo.referencia).at(-1)
      return responder(res, 200, { id: preparada?.id ?? null })
    }
    if (ruta === '/__control/reiniciar') {
      reiniciar()
      return responder(res, 200, { ok: true })
    }
    if (ruta === '/__control/estado') {
      return responder(res, 200, {
        preparadas: estado.preparadas.map(({ id, referencia, centavos }) => ({ id, referencia, centavos })),
        confirmadas: estado.confirmadas,
        revertidas: estado.revertidas,
        mensajes: estado.mensajes,
        correos: estado.correos,
        desconocidas: estado.desconocidas,
      })
    }
    return responder(res, 404, { error: 'control desconocido' })
  }

  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://falso')
    const cuerpo = req.method === 'GET' ? {} : await leerCuerpo(req)
    if (url.pathname.startsWith('/__control/')) return control(req, res, url.pathname, cuerpo)
    const [, anfitrion, ...resto] = url.pathname.split('/')
    const ruta = `/${resto.join('/')}`
    if (anfitrion === PAYPHONE) return payphone(req, res, ruta, cuerpo)
    if (anfitrion === YCLOUD) return ycloud(req, res, ruta, cuerpo)
    if (anfitrion === RESEND) return resend(req, res, ruta, cuerpo)
    estado.desconocidas.push(`${req.method} ${anfitrion}${ruta}`)
    return responder(res, 404, { message: `Sin falso para ${anfitrion}` })
  })

  return {
    escuchar: () => new Promise((resolve) => {
      servidor.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${servidor.address().port}`))
    }),
    cerrar: () => new Promise(resolve => servidor.close(() => resolve())),
  }
}
