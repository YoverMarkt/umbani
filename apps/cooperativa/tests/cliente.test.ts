import { beforeEach, describe, expect, it, vi } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════════
// EL CLIENTE DEL PANEL DE LA COOPERATIVA (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//   1. Una sesión vencida (o la cooperativa apagada) se olvida y vuelve al login.
//   2. Lo que dice el servidor se repite tal cual (no un error inventado).
//   3. Los importes, sin signo: quién le debe a quién se dice con palabras.

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

const respuesta = (status: number, cuerpo: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => cuerpo })
let fetchFalso: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('localStorage', almacen())
  vi.stubGlobal('window', { location: { hash: '#/' } })
  fetchFalso = vi.fn()
  vi.stubGlobal('fetch', fetchFalso)
})

describe('la sesión', () => {
  it('cada llamada lleva su token; vencida, se olvida y vuelve al login', async () => {
    const { api, session } = await import('../src/api/client')
    session.save('tok-coop', 'Cooperativa Chone')
    fetchFalso.mockResolvedValueOnce(respuesta(200, { repartidores: [] }))
    await api('/api/cooperativa/repartidores')
    expect(fetchFalso.mock.calls[0][1].headers.Authorization).toBe('Bearer tok-coop')

    fetchFalso.mockResolvedValueOnce(respuesta(401, { error: 'Tu acceso ya no está activo' }))
    await expect(api('/api/cooperativa/repartidores')).rejects.toMatchObject({ status: 401 })
    expect(session.token).toBeNull()
    expect(session.nombre).toBe('')
    expect(window.location.hash).toBe('#/login')
  })

  it('en el login, un 401 es «correo o contraseña incorrectos», no una sesión vencida', async () => {
    const { api } = await import('../src/api/client')
    fetchFalso.mockResolvedValueOnce(respuesta(401, { error: 'Correo o contraseña incorrectos' }))
    await expect(api('/api/cooperativa/login', { method: 'POST' })).rejects.toThrow('Correo o contraseña incorrectos')
    expect(window.location.hash).toBe('#/')
  })

  it('sin almacenamiento (ventana privada) no se cae', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('bloqueado') }, setItem: () => { throw new Error('bloqueado') }, removeItem: () => { throw new Error('bloqueado') } })
    const { session } = await import('../src/api/client')
    expect(() => session.save('t', 'C')).not.toThrow()
    expect(session.token).toBeNull()
    expect(() => session.clear()).not.toThrow()
  })
})

describe('lo que dice el servidor', () => {
  it('su mensaje de error se repite tal cual', async () => {
    const { api } = await import('../src/api/client')
    fetchFalso.mockResolvedValueOnce(respuesta(409, { error: 'Ese teléfono ya está registrado como repartidor' }))
    await expect(api('/api/cooperativa/repartidores', { method: 'POST' })).rejects.toThrow('Ese teléfono ya está registrado como repartidor')
  })
})

describe('los importes', () => {
  it('en dólares y sin signo', async () => {
    const { dolares } = await import('../src/api/client')
    expect(dolares(1250)).toBe('$12.50')
    expect(dolares(-542)).toBe('$5.42')
    expect(dolares(null)).toBe('$0.00')
  })
})
