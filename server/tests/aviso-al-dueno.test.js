import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { fuenteDeLaTienda } from './fuente-de-rutas.mjs'

const require = createRequire(import.meta.url)
const {
  textoParaElDueno, tocaAvisarAlDueno, crearAvisoAlDueno,
} = require('../dist/services/owner-order-notice')

// ═══════════════════════════════════════════════════════════════════════════
// EL AVISO DE PEDIDO NUEVO AL WHATSAPP DEL DUEÑO
// ═══════════════════════════════════════════════════════════════════════════
//
// El dueño ya se entera por la ALARMA de su panel, que es gratis. Esto es para
// el que no lo tiene abierto — está cocinando, o cerró la computadora.
//
// ⚠️ CUESTA DINERO: son DOS mensajes por pedido (resumen + mapa del cliente),
// por local y todos los días, y Meta los cobra desde el 1 de octubre de 2026.
// Por eso nace APAGADO y lo enciende quien paga. Un interruptor que nace
// encendido convierte una mejora en una factura que nadie decidió.

const NEGOCIO = {
  id: 'b1', name: 'La Abuelita',
  owner_phone: '+593990978366', notify_owner_whatsapp: true,
}
const PEDIDO = {
  order_number: 42, contact_name: 'Ana', total: '7.70',
  fulfillment: 'delivery', payment_method: 'transferencia',
  delivery_address: '7 de agosto y Rocafuerte',
  delivery_reference: 'casa verde, timbre 2',
  delivery_latitude: -1.0661434, delivery_longitude: -80.467012,
  order_items: [
    { product_name: 'Almuerzo del día', quantity: 2, order_item_options: [
      { option_group_name: 'Sopa', option_name: 'Caldo de hueso de res', quantity: 2 },
      { option_group_name: 'Segundo', option_name: 'Pollo apanado', quantity: 2 },
    ] },
  ],
}

describe('quién recibe el aviso', () => {
  it('NADIE hasta que el dueño lo encienda', () => {
    // El valor por defecto de la columna es `false`: un local recién creado no
    // gasta un centavo en esto.
    expect(tocaAvisarAlDueno({ ...NEGOCIO, notify_owner_whatsapp: false })).toBe(false)
    expect(tocaAvisarAlDueno({ ...NEGOCIO, notify_owner_whatsapp: undefined })).toBe(false)
    expect(tocaAvisarAlDueno(null)).toBe(false)
  })

  it('encendido pero sin número, tampoco: no hay a dónde mandarlo', () => {
    expect(tocaAvisarAlDueno({ ...NEGOCIO, owner_phone: null })).toBe(false)
    expect(tocaAvisarAlDueno({ ...NEGOCIO, owner_phone: '123' })).toBe(false)
  })

  it('con las dos condiciones, sí', () => {
    expect(tocaAvisarAlDueno(NEGOCIO)).toBe(true)
  })
})

describe('lo que lee el dueño', () => {
  it('lleva TODO lo que necesita para decidir sin abrir el panel', () => {
    const texto = textoParaElDueno(PEDIDO)
    expect(texto).toContain('Pedido nuevo #42')
    expect(texto).toContain('2× Almuerzo del día')
    // Lo elegido, que es lo que hay que cocinar.
    expect(texto).toContain('Caldo de hueso de res')
    expect(texto).toContain('Pollo apanado')
    expect(texto).toContain('*Total: $7.70*')
    expect(texto).toContain('transferencia')
    // Y a dónde va, con su referencia.
    expect(texto).toContain('7 de agosto y Rocafuerte')
    expect(texto).toContain('casa verde, timbre 2')
    expect(texto).toContain('Ana')
  })

  it('en un RETIRO no dice una dirección que no existe', () => {
    const texto = textoParaElDueno({ ...PEDIDO, fulfillment: 'pickup' })
    expect(texto).toContain('retira en el local')
    expect(texto).not.toContain('7 de agosto')
  })

  it('sin dirección escrita lo dice, en vez de dejar el hueco', () => {
    const texto = textoParaElDueno({ ...PEDIDO, delivery_address: null, delivery_reference: null })
    expect(texto).toContain('Sin dirección escrita')
    expect(texto).not.toContain('undefined')
  })
})

describe('el envío', () => {
  const montar = (extra = {}) => {
    const textos = []; const mapas = []
    const avisar = crearAvisoAlDueno({
      enviarTexto: async (_n, tel, m) => { textos.push({ tel, m }); return true },
      enviarUbicacion: async (_n, tel, u) => { mapas.push({ tel, u }); return true },
      registrarError: async () => {},
      ...extra,
    })
    return { avisar, textos, mapas }
  }

  it('apagado no gasta ni un mensaje', async () => {
    const { avisar, textos, mapas } = montar()
    const ok = await avisar({ ...NEGOCIO, notify_owner_whatsapp: false }, PEDIDO)
    expect(ok).toBe(false)
    expect(textos).toHaveLength(0)
    expect(mapas).toHaveLength(0)
  })

  it('encendido manda el resumen Y el mapa del CLIENTE', async () => {
    const { avisar, textos, mapas } = montar()
    await avisar(NEGOCIO, PEDIDO)
    expect(textos).toHaveLength(1)
    expect(textos[0].tel).toBe('+593990978366')
    // ⚠️ El mapa es el punto del CLIENTE, no el del local: al dueño le sirve
    // para saber a dónde hay que llevarlo, y mañana al repartidor.
    expect(mapas).toHaveLength(1)
    expect(mapas[0].u).toMatchObject({ latitude: -1.0661434, longitude: -80.467012 })
  })

  it('en un RETIRO no gasta el mapa: no hay a dónde ir', async () => {
    const { avisar, textos, mapas } = montar()
    await avisar(NEGOCIO, { ...PEDIDO, fulfillment: 'pickup' })
    expect(textos).toHaveLength(1)
    expect(mapas).toHaveLength(0)
  })

  it('sin punto del cliente tampoco gasta el mapa', async () => {
    const { avisar, mapas } = montar()
    await avisar(NEGOCIO, { ...PEDIDO, delivery_latitude: null, delivery_longitude: null })
    expect(mapas).toHaveLength(0)
  })

  it('si el mapa falla, el resumen ya se mandó', async () => {
    const { avisar, textos } = montar({
      enviarUbicacion: async () => { throw new Error('YCloud caído') },
    })
    const ok = await avisar(NEGOCIO, PEDIDO)
    expect(ok).toBe(true)
    expect(textos).toHaveLength(1)
  })

  it('si el texto falla, se registra y no se lanza', async () => {
    const errores = []
    const { avisar } = montar({
      enviarTexto: async () => { throw new Error('sin credenciales') },
      registrarError: async (e) => { errores.push(e) },
    })
    const ok = await avisar(NEGOCIO, PEDIDO)
    expect(ok).toBe(false)
    expect(errores[0]).toMatchObject({ businessId: 'b1', category: 'envio' })
  })
})

describe('el aviso está CONECTADO, no solo construido', () => {
  // ⚠️ El fallo que este proyecto ha repetido ocho veces: lógica correcta,
  // probada, con el CI en verde… y sin un solo llamador. Estas pruebas leen el
  // código fuente de los DOS caminos que crean pedidos y exigen que llamen.
  const { readFileSync } = require('node:fs')
  const { fileURLToPath } = require('node:url')
  const leer = ruta => readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), 'utf8')

  it('la MINI APP avisa al crear el pedido', () => {
    const fuente = fuenteDeLaTienda()
    expect(fuente).toMatch(/import \{ avisarAlDuenoDelPedido \}/)
    expect(fuente).toMatch(/avisarAlDuenoDelPedido\(businessId,/)
  })

  // El chat creaba pedidos hasta el 2026-09-15 y también avisaba. Ahora hay una
  // sola puerta —la mini app—, así que lo que se vigila es que no aparezca otra.
  it('el número de la plataforma ya no crea pedidos, así que no avisa', () => {
    const fuente = leer('../src/services/inbound-webhook.ts')
    expect(fuente).not.toMatch(/avisarAlDuenoDelPedido/)
  })

  it('se llama SIN await: el pedido no espera a WhatsApp', () => {
    // El pedido ya está creado y el cliente espera su confirmación. Un
    // proveedor externo lento no puede retrasar la pantalla de «recibido».
    expect(fuenteDeLaTienda()).toMatch(/void avisarAlDuenoDelPedido\(/)
  })

  it('el interruptor llega al panel del dueño', () => {
    // Sin esto la columna existiría y nadie podría encenderla — que es la otra
    // mitad del mismo fallo.
    const ruta = leer('../src/routes/business-profile.routes.ts')
    expect(ruta).toMatch(/'notify_owner_whatsapp'/)
    expect(ruta).toMatch(/notify_owner_whatsapp: business\.notify_owner_whatsapp === true/)
  })
})
