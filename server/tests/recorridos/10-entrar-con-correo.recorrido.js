import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SLUG, admin, cerrarSql, clientePorCorreo, codigoQueLlegoA, comoMotorizado, configurarElDinero, exigir, http,
  productosSimples, recogerLaMesa, sesionPorCorreo, sql,
} from './actores.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// ENTRAR A LAS APPS CON CORREO, DE PUNTA A PUNTA (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Las apps dejaron de entrar por WhatsApp. Esto recorre la puerta nueva con
// el servidor y la base de verdad, y el correo saliendo de verdad hacia
// «Resend» (el falso lo anota, y de ahí se lee el código como lo leería la
// persona). Lo que defiende, por lo que costaría fallar:
//   1. El número del que cuelgan los pedidos es de UNA persona: la cuenta de
//      correo no puede quedarse con el de otra y ver sus pedidos.
//   2. En la base no hay códigos en claro.
//   3. Con su número, la cuenta pide y ve SU pedido en «Mis pedidos».
//   4. El repartidor entra con el correo con el que lo registraron.

const CORREO = 'cliente.correo@umbani.test'
/** Otra persona que ya pidió con este número: su número no se le puede dar a nadie más. */
const NUMERO_AJENO = '593990001010'

beforeAll(async () => {
  await recogerLaMesa()
  await configurarElDinero({ envio: 1.5, margen: 10, tarifa: 0.1 })
  await sql('insert into customers (phone) values ($1) on conflict do nothing', [NUMERO_AJENO])
  // Cada vuelta empieza sin cuenta ni códigos de este correo.
  await sql('delete from app_email_codes where email = $1', [CORREO])
  await sql('delete from customers where email = $1', [CORREO])
})
afterAll(cerrarSql)

describe('entrar con el correo', () => {
  let tokenApp

  it('el código llega al correo, y la base guarda solo su huella', async () => {
    const pedido = await exigir(201, http('POST', '/api/v1/auth/correo', { cuerpo: { correo: CORREO } }))
    // Con proveedor de correo no vuelve en la respuesta, ni en este servidor.
    expect(pedido).toMatchObject({ enviado: true })
    expect(pedido).not.toHaveProperty('codigoDePruebas')
    const codigo = await codigoQueLlegoA(CORREO)
    const filas = await sql('select code_hash from app_email_codes where email = $1', [CORREO])
    expect(filas).toHaveLength(1)
    expect(filas[0].code_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(filas[0].code_hash).not.toContain(codigo)
  })

  it('un código equivocado no entra; el bueno sí, y una sola vez', async () => {
    const codigo = await codigoQueLlegoA(CORREO)
    const otro = String((Number(codigo) + 1) % 1_000_000).padStart(6, '0')
    expect((await http('POST', '/api/v1/auth/correo/verificar', { cuerpo: { correo: CORREO, codigo: otro } })).status).toBe(401)
    tokenApp = (await exigir(200, http('POST', '/api/v1/auth/correo/verificar', { cuerpo: { correo: CORREO, codigo } }))).token
    expect((await http('POST', '/api/v1/auth/correo/verificar', { cuerpo: { correo: CORREO, codigo } })).status).toBe(410)
    expect(await exigir(200, http('GET', '/api/v1/yo', { token: tokenApp }))).toMatchObject({ correo: CORREO, telefono: null })
  })

  it('🔒 sin número no abre la tienda, y el número de otra persona no se le da', async () => {
    const sinNumero = await http('POST', `/api/v1/locales/${SLUG()}/sesion`, {
      token: tokenApp, cabeceras: { 'x-storefront-device': 'recorrido-correo-1' },
    })
    expect(sinNumero.status).toBe(409)
    expect(sinNumero.body.falta).toBe('telefono')
    const ajeno = await http('PUT', '/api/v1/yo/telefono', { token: tokenApp, cuerpo: { telefono: NUMERO_AJENO } })
    expect(ajeno.status).toBe(409)
    // Y el número sigue siendo de quien era.
    const [{ count }] = await sql('select count(*)::int as count from customers where phone = $1', [NUMERO_AJENO])
    expect(count).toBe(1)
  })
})

describe('con su número, pide y lo ve', () => {
  let cliente
  let pedido

  it('pide en efectivo por la tienda del local, con la sesión de su correo', async () => {
    cliente = await clientePorCorreo(CORREO, '099 000 2020')
    expect(cliente.telefono).toBe('593990002020')
    const [primero] = productosSimples(await cliente.catalogo())
    const addressId = await cliente.direccion()
    pedido = await exigir(201, cliente.pedir_({
      items: [{ productId: primero.id, quantity: 1 }], fulfillment: 'delivery', paymentMethod: 'efectivo', addressId,
    }))
    const [fila] = await sql(`select o.contact_phone, c.email from orders o join customers c on c.id = o.customer_id where o.id = $1`, [pedido.id])
    expect(fila).toEqual({ contact_phone: '593990002020', email: CORREO })
  })

  it('«Mis pedidos» lo enseña, de su número y de nadie más', async () => {
    const { pedidos } = await exigir(200, http('GET', '/api/v1/pedidos', { token: cliente.tokenApp }))
    expect(pedidos.map(p => p.id)).toContain(pedido.id)
    const telefonos = await sql('select distinct contact_phone from orders where id = any($1::uuid[])', [pedidos.map(p => p.id)])
    expect(telefonos.map(t => t.contact_phone)).toEqual(['593990002020'])
  })
})

describe('el repartidor entra con su correo', () => {
  const CORREO_MOTO = 'moto.correo@umbani.test'

  it('registrado por Umbani con su correo, entra a su app sin WhatsApp', async () => {
    await sql('delete from couriers where email = $1 or phone = $2', [CORREO_MOTO, '593990003030'])
    const [{ id: chone }] = await sql(`select id from cities where lower(name) = 'chone'`)
    await exigir(201, admin.pedir('POST', '/api/admin/motorizados', {
      nombre: 'Moto por Correo', telefono: '099 000 3030', correo: 'Moto.Correo@Umbani.test', vehiculo: 'Moto', ciudadId: chone,
    }))
    const moto = comoMotorizado(null, { token: await sesionPorCorreo(CORREO_MOTO) })
    const yo = await exigir(200, moto.pedir('GET', '/yo'))
    expect(yo.nombre).toBe('Moto por Correo')
    await exigir(200, moto.pedir('PUT', '/disponible', { disponible: false }))
  })

  it('un correo que no es de ningún repartidor no entra', async () => {
    const moto = comoMotorizado(null, { token: await sesionPorCorreo('nadie.reparte@umbani.test') })
    expect((await moto.pedir('GET', '/yo')).status).toBe(403)
  })
})
