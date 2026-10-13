import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

// ═══════════════════════════════════════════════════════════════════════════
// LA APP WEB DE REPARTIDORES (`/r`, 2026-10-05)
// ═══════════════════════════════════════════════════════════════════════════
//
// Es la REFERENCIA de la app Flutter del motorizado. Lo que se defiende:
//   1. Su sesión va APARTE de la de cliente: entrar como repartidor no cierra
//      la sesión de quien pide en el mismo teléfono.
//   2. Cada paso va a su ruta, con su sesión, y cuando el servidor dice que no
//      (otro llegó antes, el tope, falta empacar) se repite SU mensaje.
//   3. «Cómo llegar» abre Google Maps sin clave, con o sin punto.
//   4. Cada ruta está documentada (`apps-web-contrato.test.mjs`).

const almacen = (): Storage => {
  const datos = new Map<string, string>()
  return {
    getItem: (k: string) => datos.get(k) ?? null,
    setItem: (k: string, v: string) => { datos.set(k, v) },
    removeItem: (k: string) => { datos.delete(k) },
    clear: () => datos.clear(),
    key: (i: number) => [...datos.keys()][i] ?? null,
    get length() { return datos.size },
  } as Storage
}

const respuesta = (status: number, cuerpo: unknown) => ({
  ok: status >= 200 && status < 300, status, json: async () => cuerpo,
})

let fetchFalso: ReturnType<typeof vi.fn>
// Como en `/r`: se carga la API del repartidor, que elige su llave de sesión.
const cargar = async () => {
  const repartidor = await import('../src/repartidor/api')
  const comun = await import('../src/umbani/api')
  return { repartidor, comun }
}

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('localStorage', almacen())
  vi.stubGlobal('sessionStorage', almacen())
  vi.stubGlobal('window', { location: { pathname: '/r', search: '' }, history: { replaceState: () => {} } })
  fetchFalso = vi.fn()
  vi.stubGlobal('fetch', fetchFalso)
})

describe('la sesión del repartidor', () => {
  it('va aparte de la de cliente: entrar como repartidor no toca la sesión de quien pide', async () => {
    localStorage.setItem('umbani_app_token', 'token-de-cliente')
    const { comun } = await cargar()
    comun.guardarToken('token-de-repartidor')
    expect(localStorage.getItem('umbani_repartidor_token')).toBe('token-de-repartidor')
    expect(localStorage.getItem('umbani_app_token')).toBe('token-de-cliente')
    comun.salir()
    expect(localStorage.getItem('umbani_repartidor_token')).toBeNull()
    expect(localStorage.getItem('umbani_app_token')).toBe('token-de-cliente')
  })

  it('cada llamada lleva la sesión del repartidor', async () => {
    const { repartidor, comun } = await cargar()
    comun.guardarToken('token-de-repartidor')
    fetchFalso.mockResolvedValue(respuesta(200, { pedidos: [] }))
    await repartidor.pedidos()
    const [ruta, opciones] = fetchFalso.mock.calls[0]
    expect(ruta).toBe('/api/v1/motorizado/pedidos')
    expect(opciones.headers.Authorization).toBe('Bearer token-de-repartidor')
  })
})

describe('los pasos del pedido', () => {
  it('tomar, recoger y entregar van a su ruta con POST', async () => {
    const { repartidor, comun } = await cargar()
    comun.guardarToken('t')
    fetchFalso.mockResolvedValue(respuesta(200, { ok: true }))
    await repartidor.tomar('p-1')
    await repartidor.recogido('p-1')
    await repartidor.entregado('p-1')
    expect(fetchFalso.mock.calls.map(([ruta, o]) => `${o.method} ${ruta}`)).toEqual([
      'POST /api/v1/motorizado/pedidos/p-1/tomar',
      'POST /api/v1/motorizado/pedidos/p-1/recogido',
      'POST /api/v1/motorizado/pedidos/p-1/entregado',
    ])
  })

  it('cuando el servidor dice que no, se repite SU mensaje (no uno inventado aquí)', async () => {
    const { repartidor, comun } = await cargar()
    comun.guardarToken('t')
    fetchFalso.mockResolvedValueOnce(respuesta(409, { error: 'Otro motorizado ya lo tomó', reason: 'ya_tomado' }))
    await expect(repartidor.tomar('p-1')).rejects.toMatchObject({ status: 409, message: 'Otro motorizado ya lo tomó' })
    fetchFalso.mockResolvedValueOnce(respuesta(409, { error: 'El local aún no termina de empacar: falta la bebida' }))
    await expect(repartidor.recogido('p-1')).rejects.toThrow('falta la bebida')
  })

  it('disponible se manda tal cual, con PUT', async () => {
    const { repartidor, comun } = await cargar()
    comun.guardarToken('t')
    fetchFalso.mockResolvedValue(respuesta(200, { disponible: true }))
    await repartidor.ponerDisponible(true)
    const [ruta, opciones] = fetchFalso.mock.calls[0]
    expect(ruta).toBe('/api/v1/motorizado/disponible')
    expect(opciones.method).toBe('PUT')
    expect(JSON.parse(opciones.body)).toEqual({ disponible: true })
  })

  it('un número que no es de repartidor (403) se distingue de una sesión vencida (401)', async () => {
    const { repartidor, comun } = await cargar()
    comun.guardarToken('t')
    fetchFalso.mockResolvedValueOnce(respuesta(403, { error: 'Este número no es de un motorizado activo de Umbani' }))
    await expect(repartidor.yo()).rejects.toMatchObject({ status: 403 })
    // El 403 no cierra la sesión (puede que lo registren); el 401 sí.
    expect(comun.tokenDeLaApp()).toBe('t')
    fetchFalso.mockResolvedValueOnce(respuesta(401, { error: 'Sesión vencida' }))
    await expect(repartidor.yo()).rejects.toMatchObject({ status: 401 })
    expect(comun.tokenDeLaApp()).toBe('')
  })
})

describe('cómo llegar', () => {
  it('con punto, la ruta en Google Maps; sin punto, por la dirección; sin nada, nada', async () => {
    const { repartidor } = await cargar()
    expect(repartidor.comoLlegar({ lat: -0.6995, lng: -80.093, direccion: 'Calle 1' }))
      .toBe('https://www.google.com/maps/dir/?api=1&destination=-0.6995,-80.093')
    expect(repartidor.comoLlegar({ lat: null, lng: null, direccion: 'Av. Amazonas y 7 de Agosto' }))
      .toBe('https://www.google.com/maps/search/?api=1&query=Av.%20Amazonas%20y%207%20de%20Agosto')
    expect(repartidor.comoLlegar({ lat: null, lng: null, direccion: null })).toBeNull()
  })
})

describe('la primera pantalla', () => {
  it('sin sesión de repartidor, pide entrar (aunque haya sesión de cliente)', async () => {
    localStorage.setItem('umbani_app_token', 'token-de-cliente')
    const { default: RepartidorApp } = await import('../src/repartidor/RepartidorApp')
    const html = renderToStaticMarkup(createElement(RepartidorApp))
    expect(html).toContain('Entra como repartidor')
    // Con el correo con el que lo registraron (2026-10-06), ya no con WhatsApp.
    expect(html).toContain('Enviarme el código')
    expect(html).toContain('type="email"')
    expect(html).not.toContain('WhatsApp')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// «LLEGUÉ» Y «NO ESTABA EL CLIENTE» (2026-10-12)
// ═══════════════════════════════════════════════════════════════════════════
//   1. «Llegué» manda la ubicación SOLO si la hay; sin ella va vacío (no bloquea).
//   2. El teléfono del cliente se enseña solo si el servidor lo manda (desde «Llegué»).
//   3. «No estaba el cliente» espera la hora que dio el servidor; antes, apagado
//      y diciendo desde cuándo.

describe('«Llegué» y «No estaba el cliente»', () => {
  it('cada uno a su ruta con POST; la ubicación viaja solo si la hay', async () => {
    const { repartidor, comun } = await cargar()
    comun.guardarToken('t')
    fetchFalso.mockResolvedValue(respuesta(200, { ok: true }))
    await repartidor.llegue('p-1', { lat: -0.69, lng: -80.09 })
    await repartidor.llegue('p-1', null)
    await repartidor.noEstaba('p-1')
    expect(fetchFalso.mock.calls.map(([ruta, o]) => `${o.method} ${ruta} ${o.body ?? ''}`)).toEqual([
      'POST /api/v1/motorizado/pedidos/p-1/llegue {"lat":-0.69,"lng":-80.09}',
      'POST /api/v1/motorizado/pedidos/p-1/llegue {}',
      'POST /api/v1/motorizado/pedidos/p-1/no-estaba ',
    ])
  })

  it('antes de tiempo se repite el mensaje del servidor (los minutos los cuenta él)', async () => {
    const { repartidor, comun } = await cargar()
    comun.guardarToken('t')
    fetchFalso.mockResolvedValueOnce(respuesta(409, { error: 'Espera al cliente 4 minutos más antes de marcarlo', reason: 'todavia_no' }))
    await expect(repartidor.noEstaba('p-1')).rejects.toThrow('Espera al cliente 4 minutos más antes de marcarlo')
  })

  const enCamino = (extra: Record<string, unknown> = {}) => ({
    id: 'p-1', numero: 7, estado: 'en_camino', mio: true, totalCents: 1094, carreraCents: 150,
    cobrarEnEfectivo: true, cobrarCents: 1094,
    recoger: { local: 'Local', direccion: 'Calle 1', lat: null, lng: null },
    entregar: { cliente: 'Ana', direccion: 'Calle 2', referencia: null, notas: null, lat: null, lng: null },
    ...extra,
  })
  const pintar = async (pedido: Record<string, unknown>, liquidaConUmbani = true) => {
    const { PedidoMio } = await import('../src/repartidor/RepartidorApp')
    return renderToStaticMarkup(createElement(PedidoMio, {
      pedido: pedido as never, liquidaConUmbani, onListo: async () => {}, alFallar: () => null,
    }))
  }

  it('en camino y sin «Llegué»: el botón «Llegué», y ni teléfono ni «No estaba»', async () => {
    const html = await pintar(enCamino())
    expect(html).toContain('Llegué a la puerta')
    expect(html).not.toContain('Llamar al cliente')
    expect(html).not.toContain('No estaba el cliente')
  })

  it('desde «Llegué»: llamar al cliente, y «No estaba» apagado hasta la hora del servidor', async () => {
    const pronto = new Date(Date.now() + 6 * 60_000).toISOString()
    const html = await pintar(enCamino({
      llegoEn: new Date().toISOString(), noEstabaDesde: pronto,
      entregar: { cliente: 'Ana', direccion: 'Calle 2', referencia: null, notas: null, lat: null, lng: null, telefono: '+593990000811' },
    }))
    expect(html).toContain('href="tel:+593990000811"')
    expect(html).toContain('Llamar al cliente')
    expect(html).toContain('No estaba el cliente · desde las')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>No estaba el cliente · desde las/)
    expect(html).not.toContain('Llegué a la puerta')
  })

  it('pasada la hora, «No estaba el cliente» se puede tocar', async () => {
    const html = await pintar(enCamino({ llegoEn: '2026-10-12T20:00:00Z', noEstabaDesde: '2026-10-12T20:10:00Z' }))
    // El atributo, no la clase: los estilos del botón dicen `disabled:` siempre.
    expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*>No estaba el cliente<\/button>/)
  })

  it('antes de recoger no hay «Llegué»', async () => {
    const html = await pintar(enCamino({ estado: 'aceptado' }))
    expect(html).toContain('Ya lo recogí')
    expect(html).not.toContain('Llegué')
  })
})
