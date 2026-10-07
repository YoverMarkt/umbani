import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  CODIGOS_POR_HORA, INTENTOS_POR_CODIGO, canjearCodigoDeCorreo, generarCodigoDeCorreo, huellaDelCodigo,
  mensajeDelCodigo, pedirCodigoPorCorreo,
} = require('../dist/services/entrar-con-correo')
const { correoNormalizado } = require('../dist/lib/correo-normalizado')
const { enviarCorreo } = require('../dist/services/correo')

// ═══════════════════════════════════════════════════════════════════════════
// ENTRAR CON CORREO: CADA DEFENSA, CONTRA LO QUE LA HIZO FALTA
// ═══════════════════════════════════════════════════════════════════════════
//
// Sin base ni correo de verdad: las reglas viven en un servicio que recibe sus
// piezas, así que cada una se comprueba sola. Lo que se defiende:
//   · el código no se guarda en claro;
//   · nadie llena el buzón de otro (5 por hora y correo);
//   · el código solo se ve en pantalla en STAGING;
//   · 5 intentos, y cada intento se gana ANTES de comparar;
//   · un código se usa una vez.

const SECRETO = 'secreto-de-prueba'
const CORREO = 'ana@correo.com'

/** Un almacén en memoria con las mismas reglas que el repositorio. */
function piezas({ proveedor = true, staging = false, recientes = 0, envio = 'enviado' } = {}) {
  const guardados = []
  const enviados = []
  const d = {
    hayProveedor: () => proveedor,
    esStaging: () => staging,
    secreto: () => SECRETO,
    contarCodigos: vi.fn(async () => recientes),
    guardarCodigo: vi.fn(async (correo, huella, expira) => {
      guardados.push({ id: `c${guardados.length + 1}`, correo, code_hash: huella, expira, attempts: 0, usado: false })
    }),
    enviar: vi.fn(async (correo) => { enviados.push(correo); return envio }),
    codigoVigente: vi.fn(async (correo) => {
      const ultimo = guardados.filter(g => g.correo === correo).at(-1)
      return ultimo && !ultimo.usado ? { id: ultimo.id, code_hash: ultimo.code_hash, attempts: ultimo.attempts } : null
    }),
    gastarIntento: vi.fn(async (id, antes) => {
      const fila = guardados.find(g => g.id === id)
      if (!fila || fila.attempts !== antes || fila.usado) return false
      fila.attempts = antes + 1
      return true
    }),
    marcarUsado: vi.fn(async (id) => {
      const fila = guardados.find(g => g.id === id)
      if (!fila || fila.usado) return false
      fila.usado = true
      return true
    }),
  }
  return { d, guardados, enviados }
}

/** El código que llevó el último correo enviado. */
const codigoEnviado = (enviados) => enviados.at(-1).texto.match(/\b(\d{6})\b/)[1]

describe('pedir el código', () => {
  it('lo manda por correo y guarda SOLO su huella', async () => {
    const { d, guardados, enviados } = piezas()
    const r = await pedirCodigoPorCorreo(CORREO, d)
    expect(r.estado).toBe('enviado')
    expect(new Date(r.expiraEn).getTime()).toBeGreaterThan(Date.now())
    expect(enviados).toHaveLength(1)
    expect(enviados[0].para).toBe(CORREO)
    const codigo = codigoEnviado(enviados)
    // Con la base filtrada no se entra: lo guardado no contiene el código…
    expect(guardados[0].code_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(guardados[0].code_hash).not.toContain(codigo)
    // …y sin el secreto del servidor no se puede rehacer.
    expect(guardados[0].code_hash).toBe(huellaDelCodigo(CORREO, codigo, SECRETO))
    expect(huellaDelCodigo(CORREO, codigo, 'otro-secreto')).not.toBe(guardados[0].code_hash)
  })

  it(`con ${CODIGOS_POR_HORA} en la última hora no manda más: el buzón de nadie se llena desde aquí`, async () => {
    const { d, guardados, enviados } = piezas({ recientes: CODIGOS_POR_HORA })
    expect(await pedirCodigoPorCorreo(CORREO, d)).toEqual({ estado: 'demasiados' })
    expect(guardados).toHaveLength(0)
    expect(enviados).toHaveLength(0)
    // Cuenta la última hora, no la vida entera del correo.
    const desde = d.contarCodigos.mock.calls[0][1]
    expect(Date.now() - desde.getTime()).toBeGreaterThanOrEqual(60 * 60 * 1000 - 1000)
  })

  it('en STAGING sin proveedor, el código vuelve en la respuesta para poder probar', async () => {
    const { d, enviados } = piezas({ proveedor: false, staging: true })
    const r = await pedirCodigoPorCorreo(CORREO, d)
    expect(r.estado).toBe('pruebas')
    expect(r.codigo).toMatch(/^\d{6}$/)
    expect(enviados).toHaveLength(0)
  })

  it('en PRODUCCIÓN sin proveedor dice que no está disponible, y no guarda nada', async () => {
    const { d, guardados } = piezas({ proveedor: false, staging: false })
    expect(await pedirCodigoPorCorreo(CORREO, d)).toEqual({ estado: 'no_disponible' })
    expect(guardados).toHaveLength(0)
  })

  it('con proveedor, ni siquiera en staging el código vuelve en la respuesta', async () => {
    const { d } = piezas({ proveedor: true, staging: true })
    const r = await pedirCodigoPorCorreo(CORREO, d)
    expect(r).not.toHaveProperty('codigo')
  })

  it('si el proveedor falla, lo dice', async () => {
    const { d } = piezas({ envio: 'fallo' })
    expect(await pedirCodigoPorCorreo(CORREO, d)).toEqual({ estado: 'fallo' })
  })
})

describe('canjear el código', () => {
  const conCodigo = async (opciones) => {
    const p = piezas(opciones)
    await pedirCodigoPorCorreo(CORREO, p.d)
    return { ...p, codigo: codigoEnviado(p.enviados) }
  }
  const otro = codigo => String((Number(codigo) + 1) % 1_000_000).padStart(6, '0')

  it('el bueno entra, una sola vez', async () => {
    const { d, codigo } = await conCodigo()
    expect(await canjearCodigoDeCorreo(CORREO, codigo, d)).toBe('ok')
    expect(await canjearCodigoDeCorreo(CORREO, codigo, d)).toBe('vencido')
  })

  it(`con ${INTENTOS_POR_CODIGO} intentos fallidos, el código muere aunque después llegue el bueno`, async () => {
    const { d, codigo } = await conCodigo()
    for (let i = 1; i < INTENTOS_POR_CODIGO; i++) expect(await canjearCodigoDeCorreo(CORREO, otro(codigo), d)).toBe('incorrecto')
    expect(await canjearCodigoDeCorreo(CORREO, otro(codigo), d)).toBe('vencido')
    expect(await canjearCodigoDeCorreo(CORREO, codigo, d)).toBe('vencido')
  })

  it('cada intento se gana ANTES de comparar: el que pierde la carrera no se compara', async () => {
    const { d, codigo } = await conCodigo()
    d.gastarIntento.mockResolvedValueOnce(false)
    // Ni siquiera el código bueno pasa si no se ganó su intento.
    expect(await canjearCodigoDeCorreo(CORREO, codigo, d)).toBe('incorrecto')
    expect(d.marcarUsado).not.toHaveBeenCalled()
  })

  it('solo vale el ÚLTIMO pedido: quien adivina no reparte intentos entre varios', async () => {
    const p = piezas()
    await pedirCodigoPorCorreo(CORREO, p.d)
    const primero = codigoEnviado(p.enviados)
    await pedirCodigoPorCorreo(CORREO, p.d)
    const segundo = codigoEnviado(p.enviados)
    if (primero !== segundo) expect(await canjearCodigoDeCorreo(CORREO, primero, p.d)).toBe('incorrecto')
    expect(await canjearCodigoDeCorreo(CORREO, segundo, p.d)).toBe('ok')
  })

  it('algo que no son 6 dígitos ni llega a la base', async () => {
    const { d } = await conCodigo()
    expect(await canjearCodigoDeCorreo(CORREO, '12a456', d)).toBe('incorrecto')
    expect(await canjearCodigoDeCorreo(CORREO, '', d)).toBe('incorrecto')
    expect(d.codigoVigente).not.toHaveBeenCalled()
  })

  it('sin código pedido (o ya caducado) responde que no vale', async () => {
    const { d } = piezas()
    expect(await canjearCodigoDeCorreo(CORREO, '123456', d)).toBe('vencido')
  })

  it('dos canjes a la vez del mismo código: solo uno entra', async () => {
    const { d, codigo } = await conCodigo()
    d.marcarUsado.mockResolvedValueOnce(false)
    expect(await canjearCodigoDeCorreo(CORREO, codigo, d)).toBe('vencido')
  })
})

describe('el código y el correo', () => {
  it('son 6 dígitos, también los que empiezan por cero', () => {
    for (let i = 0; i < 200; i++) expect(generarCodigoDeCorreo()).toMatch(/^\d{6}$/)
  })

  it('el asunto lleva el código delante: se lee en la notificación', () => {
    const m = mensajeDelCodigo(CORREO, '012345')
    expect(m.asunto.startsWith('012345')).toBe(true)
    expect(m.texto).toContain('10 minutos')
    expect(m.html).toContain('012345')
  })

  it('el correo se guarda en minúsculas y sin espacios, y lo que no lo parece no entra', () => {
    expect(correoNormalizado('  Ana@Correo.COM ')).toBe('ana@correo.com')
    for (const malo of ['', 'ana', 'ana@', '@correo.com', 'ana@correo', 'a b@correo.com', null, undefined]) {
      expect(correoNormalizado(malo)).toBeNull()
    }
  })
})

describe('mandar el correo', () => {
  const mensaje = mensajeDelCodigo(CORREO, '123456')

  it('sin las dos variables no intenta nada', async () => {
    const pedir = vi.fn()
    expect(await enviarCorreo(mensaje, { config: null, fetch: pedir })).toBe('sin_proveedor')
    expect(pedir).not.toHaveBeenCalled()
  })

  it('con ellas, una petición a Resend con su clave y el remitente', async () => {
    const pedir = vi.fn(async () => ({ ok: true, status: 200 }))
    const config = { clave: 're_prueba', remitente: 'Umbani <hola@umbani.test>' }
    expect(await enviarCorreo(mensaje, { config, fetch: pedir })).toBe('enviado')
    const [url, opciones] = pedir.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(opciones.headers.Authorization).toBe('Bearer re_prueba')
    expect(JSON.parse(opciones.body)).toMatchObject({ from: config.remitente, to: [CORREO], subject: mensaje.asunto })
  })

  it('si el proveedor dice que no, o no contesta, es un fallo y no rompe a quien llama', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const config = { clave: 're_prueba', remitente: 'hola@umbani.test' }
    expect(await enviarCorreo(mensaje, { config, fetch: async () => ({ ok: false, status: 422 }) })).toBe('fallo')
    expect(await enviarCorreo(mensaje, { config, fetch: async () => { throw new Error('timeout') } })).toBe('fallo')
  })
})
