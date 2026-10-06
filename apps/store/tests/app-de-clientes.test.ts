import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

// ═══════════════════════════════════════════════════════════════════════════
// LA APP WEB DE CLIENTES (`/u`, 2026-10-05)
// ═══════════════════════════════════════════════════════════════════════════
//
// Es la REFERENCIA de la app Flutter: lo que se defiende aquí es que hable con
// la API como la app de tu amigo tendrá que hablar.
//   1. Entrar a un local pide su sesión con el token de la app y el MISMO
//      dispositivo que usa la tienda (la sesión queda atada a él).
//   2. Una sesión vencida se olvida; un código vencido se dice.
//   3. Cada ruta que usa está documentada (`apps-web-contrato.test.mjs`).

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
const cargar = async () => import('../src/umbani/api')

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('localStorage', almacen())
  vi.stubGlobal('sessionStorage', almacen())
  vi.stubGlobal('window', { location: { pathname: '/u', search: '' }, history: { replaceState: () => {} } })
  fetchFalso = vi.fn()
  vi.stubGlobal('fetch', fetchFalso)
})

describe('entrar a un local', () => {
  it('pide su sesión con el token de la app y el dispositivo de la tienda, y abre la tienda', async () => {
    const api = await cargar()
    const { deviceId } = await import('../src/lib/session')
    api.guardarToken('token-de-la-app')
    fetchFalso.mockResolvedValue(respuesta(200, { token: 'tok-tienda' }))
    const destino = await api.abrirLocal('monster-pizza')
    expect(destino).toBe('/t/monster-pizza?s=tok-tienda')
    const [ruta, opciones] = fetchFalso.mock.calls[0]
    expect(ruta).toBe('/api/v1/locales/monster-pizza/sesion')
    expect(opciones.method).toBe('POST')
    expect(opciones.headers.Authorization).toBe('Bearer token-de-la-app')
    expect(opciones.headers['x-storefront-device']).toBe(deviceId())
  })

  it('una sesión vencida (401) se olvida, para pedir entrar otra vez', async () => {
    const api = await cargar()
    api.guardarToken('vencido')
    fetchFalso.mockResolvedValue(respuesta(401, { error: 'Sesión vencida' }))
    await expect(api.abrirLocal('monster-pizza')).rejects.toMatchObject({ status: 401 })
    expect(api.tokenDeLaApp()).toBe('')
  })

  it('sin conexión se dice así, no con un error técnico', async () => {
    const api = await cargar()
    fetchFalso.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(api.ciudades()).rejects.toThrow(/Sin conexión/)
  })
})

describe('entrar con WhatsApp', () => {
  it('mientras el mensaje no llega es «pendiente»; cuando llega, el token', async () => {
    const api = await cargar()
    fetchFalso.mockResolvedValueOnce(respuesta(202, { pendiente: true }))
    expect(await api.verificarCodigo('K7P2QX')).toEqual({ pendiente: true })
    fetchFalso.mockResolvedValueOnce(respuesta(200, { token: 'nuevo', telefono: '593999111222' }))
    expect((await api.verificarCodigo('K7P2QX')).token).toBe('nuevo')
  })

  it('un código vencido (410) se dice', async () => {
    const api = await cargar()
    fetchFalso.mockResolvedValue(respuesta(410, { error: 'Ese código ya no vale. Pide uno nuevo.' }))
    await expect(api.verificarCodigo('K7P2QX')).rejects.toMatchObject({ status: 410 })
  })
})

describe('la ciudad', () => {
  it('se recuerda en el teléfono, y un valor roto no rompe la app', async () => {
    const api = await cargar()
    expect(api.ciudadGuardada()).toBeNull()
    api.recordarCiudad({ id: 'c1', nombre: 'Chone' })
    expect(api.ciudadGuardada()).toEqual({ id: 'c1', nombre: 'Chone' })
    localStorage.setItem('umbani_ciudad', '{roto')
    expect(api.ciudadGuardada()).toBeNull()
  })

  it('sin sesión no se manda a Umbani; con sesión, sí (la misma que usa el chat)', async () => {
    const api = await cargar()
    await api.guardarCiudad({ id: 'c1', nombre: 'Chone' })
    expect(fetchFalso).not.toHaveBeenCalled()
    api.guardarToken('t')
    fetchFalso.mockResolvedValue(respuesta(200, { ciudadId: 'c1', nombre: 'Chone' }))
    await api.guardarCiudad({ id: 'c1', nombre: 'Chone' })
    const [ruta, opciones] = fetchFalso.mock.calls[0]
    expect(ruta).toBe('/api/v1/yo/ciudad')
    expect(JSON.parse(opciones.body)).toEqual({ ciudadId: 'c1' })
  })

  it('el menú se pide SIEMPRE con la ciudad', async () => {
    const api = await cargar()
    fetchFalso.mockResolvedValue(respuesta(200, { categorias: [] }))
    await api.menuDeLaCiudad('c1')
    expect(fetchFalso.mock.calls[0][0]).toBe('/api/v1/marketplace?ciudad=c1')
  })
})

describe('la primera pantalla', () => {
  it('sin ciudad guardada, pregunta dónde estás (GPS primero, la lista después)', async () => {
    const { default: UmbaniApp } = await import('../src/umbani/UmbaniApp')
    const html = renderToStaticMarkup(createElement(UmbaniApp))
    expect(html).toContain('¿Dónde estás?')
    expect(html).toContain('Usar mi ubicación')
    expect(html).toContain('Elegir mi ciudad')
  })
})
