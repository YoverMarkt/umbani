import { beforeEach, describe, expect, it, vi } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════════
// EL CAPTCHA AL PEDIR EL CÓDIGO, EN LA APP (Turnstile, 2026-10-09)
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo que se defiende:
//   1. El widget se pinta invisible, con la MISMA acción que comprueba el
//      servidor, y cada ficha se pide en el momento de mandar.
//   2. Una ficha vale una vez: la segunda petición reinicia el widget antes.
//   3. Si Cloudflare falla, la persona recibe un mensaje, no una espera eterna.
//   4. La llamada manda la ficha solo cuando la hay.
// (La tienda prueba sin navegador: se finge un Turnstile de mentira.)

interface Opciones {
  sitekey: string
  action: string
  execution: string
  appearance: string
  callback: (ficha: string) => void
  'error-callback': () => boolean
}

let opciones: Opciones
let turnstile: { render: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.resetModules()
  turnstile = {
    render: vi.fn((_lugar: unknown, o: Opciones) => { opciones = o; return 'widget-1' }),
    execute: vi.fn(),
    reset: vi.fn(),
    remove: vi.fn(),
  }
  vi.stubGlobal('window', { turnstile })
})

const preparar = async () => {
  const { prepararFichaHumana } = await import('../src/lib/turnstile')
  return prepararFichaHumana({} as HTMLElement, '0x4AAAAAAAsitio')
}

describe('el widget', () => {
  it('se pinta invisible, con la clave del servidor y la acción de entrar', async () => {
    await preparar()
    expect(opciones).toMatchObject({
      sitekey: '0x4AAAAAAAsitio', action: 'entrar-correo', execution: 'execute', appearance: 'interaction-only',
    })
  })

  it('la ficha se pide al mandar, y la segunda reinicia el widget (cada una vale una vez)', async () => {
    const humano = await preparar()
    const primera = humano.obtener()
    expect(turnstile.execute).toHaveBeenCalledWith('widget-1')
    expect(turnstile.reset).not.toHaveBeenCalled()
    opciones.callback('ficha-1')
    expect(await primera).toBe('ficha-1')

    const segunda = humano.obtener()
    expect(turnstile.reset).toHaveBeenCalledWith('widget-1')
    opciones.callback('ficha-2')
    expect(await segunda).toBe('ficha-2')
  })

  it('si Cloudflare falla, la persona lee qué pasó (no se queda esperando)', async () => {
    const { NO_COMPROBADO } = await import('../src/lib/turnstile')
    const humano = await preparar()
    const ficha = humano.obtener()
    expect(opciones['error-callback']()).toBe(true)
    await expect(ficha).rejects.toThrow(NO_COMPROBADO)
  })

  it('al salir de la pantalla se quita', async () => {
    const humano = await preparar()
    humano.quitar()
    expect(turnstile.remove).toHaveBeenCalledWith('widget-1')
  })
})

describe('la llamada', () => {
  const respuesta = (status: number, cuerpo: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => cuerpo })
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

  beforeEach(() => {
    vi.stubGlobal('localStorage', almacen())
    vi.stubGlobal('sessionStorage', almacen())
    vi.stubGlobal('window', { location: { pathname: '/u', search: '' }, history: { replaceState: () => {} } })
  })

  it('la clave del captcha sale de /api/v1/auth/config', async () => {
    const fetchFalso = vi.fn().mockResolvedValue(respuesta(200, { turnstile: { claveDeSitio: '0x4AAAAAAAsitio' } }))
    vi.stubGlobal('fetch', fetchFalso)
    const api = await import('../src/umbani/api')
    expect(await api.configDeEntrada()).toEqual({ turnstile: { claveDeSitio: '0x4AAAAAAAsitio' } })
    expect(fetchFalso.mock.calls[0][0]).toBe('/api/v1/auth/config')
  })

  it('pedir el código manda la ficha solo cuando la hay', async () => {
    const fetchFalso = vi.fn().mockResolvedValue(respuesta(201, { enviado: true, expiraEn: 'x' }))
    vi.stubGlobal('fetch', fetchFalso)
    const api = await import('../src/umbani/api')
    await api.pedirCodigoPorCorreo('ana@correo.com', 'ficha-1')
    await api.pedirCodigoPorCorreo('ana@correo.com')
    expect(JSON.parse(fetchFalso.mock.calls[0][1].body)).toEqual({ correo: 'ana@correo.com', turnstile: 'ficha-1' })
    expect(JSON.parse(fetchFalso.mock.calls[1][1].body)).toEqual({ correo: 'ana@correo.com' })
  })

  it('un 403 «falta turnstile» llega a la pantalla con su motivo, para montar el captcha', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta(403, { error: 'No pudimos comprobar que eres una persona.', falta: 'turnstile' })))
    const api = await import('../src/umbani/api')
    await expect(api.pedirCodigoPorCorreo('ana@correo.com')).rejects.toMatchObject({ status: 403, falta: 'turnstile' })
  })
})
