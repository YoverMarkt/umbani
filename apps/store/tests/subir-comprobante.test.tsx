import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

// ═══════════════════════════════════════════════════════════════════════════
// EL COMPROBANTE SE SUBE EN LA APP (2026-10-09)
// ═══════════════════════════════════════════════════════════════════════════
//
// Umbani es solo app: el comprobante de una transferencia ya no se manda por
// WhatsApp, se sube en la pantalla del pedido. Aquí, lo que enseña el
// componente y lo que hace la llamada con cada respuesta del servidor. (La
// tienda prueba sin navegador: se finge lo justo de él.)

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
  vi.resetModules()
  vi.stubGlobal('localStorage', almacen())
  vi.stubGlobal('sessionStorage', almacen())
  vi.stubGlobal('window', {
    location: { pathname: '/t/la-abuelita', search: '' },
    history: { replaceState: () => {} },
  })
  localStorage.setItem('vz_store_token:la-abuelita', 'token-de-la-tienda')
})
afterEach(() => { vi.unstubAllGlobals() })

const foto = () => new File([new Uint8Array([0xff, 0xd8, 0xff])], 'captura.jpg', { type: 'image/jpeg' })

describe('la pantalla', () => {
  it('dice qué hacer, que vaya a su nombre, y ofrece subir la captura', async () => {
    const { default: SubirComprobante } = await import('../src/components/SubirComprobante')
    const html = renderToStaticMarkup(<SubirComprobante slug="la-abuelita" orderId="pedido-1" />)
    expect(html).toContain('Sube tu comprobante')
    expect(html).toContain('Tiene que estar a tu nombre')
    expect(html).toContain('Subir la captura')
    // El campo de verdad acepta imágenes: galería o cámara.
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="image\/\*"/)
    expect(html).not.toMatch(/whatsapp/i)
  })
})

describe('la subida', () => {
  it('va al pedido, con la sesión de la tienda, como multipart', async () => {
    const llamada = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', llamada)
    const { uploadPaymentProof } = await import('../src/lib/api')

    expect(await uploadPaymentProof('la-abuelita', 'pedido-1', foto())).toBeNull()
    const [url, opciones] = llamada.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/store/la-abuelita/orders/pedido-1/proof')
    expect(opciones.method).toBe('POST')
    expect((opciones.headers as Record<string, string>)['x-storefront-token']).toBe('token-de-la-tienda')
    // Sin `Content-Type` a mano: lo pone el navegador con la frontera.
    expect(opciones.headers).not.toHaveProperty('Content-Type')
    expect((opciones.body as FormData).get('file')).toBeInstanceOf(File)
  })

  it('si el servidor dice que no, devuelve SU texto para enseñarlo', async () => {
    for (const [estado, error] of [[413, 'Archivo demasiado grande (máx 5MB)'], [404, 'Ese pedido no es tuyo o ya no existe']] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error }), { status: estado })))
      const { uploadPaymentProof } = await import('../src/lib/api')
      expect(await uploadPaymentProof('la-abuelita', 'pedido-1', foto()), String(estado)).toBe(error)
    }
  })

  it('demasiados intentos, o sin conexión: un texto claro, nunca una excepción', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })))
    let { uploadPaymentProof } = await import('../src/lib/api')
    expect(await uploadPaymentProof('la-abuelita', 'pedido-1', foto())).toMatch(/Espera un minuto/)

    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    ;({ uploadPaymentProof } = await import('../src/lib/api'))
    expect(await uploadPaymentProof('la-abuelita', 'pedido-1', foto())).toMatch(/Revisa tu conexión/)
  })
})
