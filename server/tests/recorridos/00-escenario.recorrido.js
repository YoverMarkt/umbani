import { afterAll, describe, expect, it } from 'vitest'
import { cerrarSql, clientePorLaApp, clientePorWhatsApp, entrarComoLocal, http, payphone, sql } from './actores.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// EL ESCENARIO SE SOSTIENE
// ═══════════════════════════════════════════════════════════════════════════
//
// Antes de recorrer un pedido, las cuatro puertas tienen que abrir: el
// servidor, el cliente por WhatsApp, el cliente por la app y el local. Si una
// falla aquí, el resto de recorridos fallaría por un motivo que no es suyo.

afterAll(cerrarSql)

describe('el escenario de los recorridos', () => {
  it('el servidor contesta y su base es la del staging, no la de producción', async () => {
    const salud = await http('GET', '/api/health')
    expect(salud.status).toBe(200)
    const [{ n }] = await sql(`select count(*)::int as n from businesses where slug = 'demo'`)
    expect(n).toBe(1)
  })

  it('el cliente de hoy entra por WhatsApp y ve la carta', async () => {
    const cliente = await clientePorWhatsApp()
    const carta = await cliente.catalogo()
    expect(carta.products?.length || carta.categories?.length).toBeGreaterThan(0)
  })

  it('el cliente de la app entra con su correo y su celular', async () => {
    const cliente = await clientePorLaApp()
    expect(cliente.telefono).toMatch(/^5939\d{8}$/)
    const yo = await http('GET', '/api/v1/yo', { token: cliente.tokenApp })
    expect(yo.status).toBe(200)
  })

  it('el local entra a su panel', async () => {
    const local = await entrarComoLocal()
    expect(local.token).toBeTruthy()
  })

  it('nada sale a internet: ninguna llamada a un proveedor sin falso', async () => {
    const { desconocidas } = await payphone.estado()
    expect(desconocidas).toEqual([])
  })
})
