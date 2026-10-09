import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { publicBusiness } = require('../dist/services/storefront')
const { textoDelAviso } = require('../dist/services/order-notify')

// ═══════════════════════════════════════════════════════════════════════════
// EL CLIENTE HABLA CON UN SOLO NÚMERO: EL DE UMBANI
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ Corrección del dueño, 2026-09-07: «todo se envía al marketplace, solo
// existe un número, el de Umbani, donde se envían comprobantes, ubicación,
// etc., y ya por detrás le llega a cada local. El campo de número del dueño es
// solo para que él pida reportes.»
//
// Dos sitios se saltaban esa regla:
//
//   · El checkout, cuando el local no tenía datos bancarios, respondía
//     «Escríbeles al {teléfono} para coordinar el pago». Eso parte la
//     conversación en dos: el comprobante, la ubicación y el seguimiento
//     viajan por Umbani, y el cliente se llevaría el pedido a un número que no
//     los recibe.
//   · La mini app tenía a `businesses.phone` como respaldo del canal. Estaba
//     LATENTE —con el campo vacío caía al número de la plataforma y parecía
//     correcto— y se habría disparado el día que alguien rellenara la ficha.
//
// La distinción que importa: `whatsapp_number` es un CANAL propio del local
// (legítimo, hay negocios que lo tienen); `phone` es un dato de CONTACTO del
// dueño, el mismo con el que pide sus reportes.

// ⚠️ El checkout DENTRO del chat se retiró el 2026-09-15 con el pedido por
// chat, y con él sus dos pruebas de aquí: ya no hay una pantalla del chat que
// pueda mandar al cliente a otro número. Lo que queda —la mini app y el aviso
// del pedido cancelado— sigue vigilado abajo.
describe('la mini app enseña el número de la PLATAFORMA, no el del dueño', () => {
  const base = {
    id: 'b1', slug: 'la-abuelita', name: 'La Abuelita', active: true,
    takes_orders: true, storefront_enabled: true,
  }

  it('`businesses.phone` NO se usa como canal: cae al de la plataforma', () => {
    // El caso que se habría disparado al rellenar la ficha del local.
    const app = publicBusiness(
      { ...base, phone: '0978619700', whatsapp_number: null },
      null,
      '+593991716574',
    )
    expect(app.phone).toBe('+593991716574')
    expect(app.phone).not.toContain('0978619700')
    // Y la app tiene que saber que es el de Umbani, o dará la instrucción
    // equivocada: «escríbele a Umbani y elige tu local».
    expect(app.phoneIsPlatform).toBe(true)
  })

  // ⚠️ Esta prueba decía lo contrario hace unas horas —«un local con canal
  // propio sigue usando el suyo»— y el dueño la cerró el mismo día: «todo
  // tiene que pasar por Umbani, todo; chat, menú, mini app, absolutamente
  // todo; nada por el local del dueño». Y la evidencia lo respalda: el canal
  // propio se retiró del panel el 2026-08-23 («todos los locales viven en el
  // marketplace»), el alta fuerza `whatsapp_provider = 'marketplace'`, y en
  // producción no hay un solo local con número propio ni un solo canal
  // registrado. Lo que quedaba era una columna sin pantalla que la llenara,
  // capaz de decidir a dónde se manda al cliente.
  it('ni un `whatsapp_number` en la ficha cambia el número', () => {
    const app = publicBusiness(
      { ...base, phone: '0978619700', whatsapp_number: '+593987654321' },
      null,
      '+593991716574',
    )
    expect(app.phone).toBe('+593991716574')
    expect(app.phoneIsPlatform).toBe(true)
  })
})

describe('un pedido cancelado tampoco saca al cliente de Umbani', () => {
  // ⚠️ Hasta el 2026-09-07 este aviso decía «llámalos al {teléfono}» con
  // `businesses.phone`. Es el peor momento para mandar a alguien fuera: acaban
  // de cancelarle el pedido, y ese número es el de CONTACTO del dueño —el de
  // los reportes—, no un canal que atienda clientes. Quien llamara ahí no
  // encontraría su pedido, porque el pedido vive en esta conversación.
  it('dice qué pasó y remite a ESTA conversación, sin teléfonos', () => {
    for (const estado of ['cancelado', 'rechazado']) {
      const texto = textoDelAviso(
        { name: 'La Abuelita' },
        { order_number: 12, contact_phone: '593999111222', total: 17.6 },
        estado,
      )
      expect(texto).toContain('fue cancelado')
      expect(texto).toContain('escríbenos por aquí')
      expect(texto).not.toMatch(/llámalos/i)
      expect(texto).not.toMatch(/\d{7,}/)
    }
  })
})
