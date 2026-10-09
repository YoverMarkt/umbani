import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { unaVezCada } from '../dist/lib/una-vez-cada.js'
import {
  ESPERA_DE_CABECERAS_MS, ESPERA_DE_LA_PETICION_MS, ajustarTiemposDeEspera,
} from '../dist/lib/tiempos-de-espera.js'

// ═══════════════════════════════════════════════════════════════════════════
// LAS DEFENSAS DEL SERVIDOR CONTRA BOTS Y ATAQUES (2026-10-08)
// ═══════════════════════════════════════════════════════════════════════════
//
// Dos piezas pequeñas y el guardián de que estén ENCHUFADAS: una defensa que
// nadie llama pasa sus pruebas en verde y no defiende nada (`camino-real`).
//   · `/api/health` pregunta a la base como mucho una vez cada 2 s.
//   · Las cabeceras tienen 20 s para llegar (contra «slowloris»).
// Lo que se mide contra el servidor de verdad está en `carga-staging.mjs`.

const indexTs = readFileSync('src/index.ts', 'utf8')

describe('unaVezCada: una lectura compartida', () => {
  it('dentro de la ventana todos reciben la MISMA lectura, sin volver a leer', async () => {
    let t = 0
    let lecturas = 0
    const leer = unaVezCada(2000, async () => ++lecturas, () => t)
    expect(await leer()).toBe(1)
    t = 1999
    expect(await leer()).toBe(1)
    t = 2000
    expect(await leer()).toBe(2)
  })

  it('las que llegan mientras la consulta está en vuelo esperan a esa misma', async () => {
    let lecturas = 0
    let soltar
    const leer = unaVezCada(2000, () => { lecturas++; return new Promise(r => { soltar = r }) }, () => 0)
    const a = leer()
    const b = leer()
    const c = leer()
    soltar('ok')
    expect(await Promise.all([a, b, c])).toEqual(['ok', 'ok', 'ok'])
    expect(lecturas).toBe(1)
  })

  it('un fallo no se queda guardado: la siguiente pregunta lo reintenta', async () => {
    let intento = 0
    const leer = unaVezCada(2000, async () => {
      intento++
      if (intento === 1) throw new Error('la base no contestó')
      return 'bien'
    }, () => 0)
    await expect(leer()).rejects.toThrow('la base no contestó')
    expect(await leer()).toBe('bien')
  })
})

describe('/api/health no multiplica las consultas a la base', () => {
  const ruta = indexTs.slice(indexTs.indexOf("app.get('/api/health'"))
  const cuerpo = ruta.slice(0, ruta.indexOf('\n}))'))

  it('la ruta lee la base a través de la lectura compartida, nunca directo', () => {
    expect(cuerpo, 'no encuentro la ruta: este guardián miraría la nada').toContain('res.status(ok ? 200 : 503)')
    expect(cuerpo).toContain('await leerLaBaseParaLaSalud()')
    expect(cuerpo).not.toMatch(/db\.getLastInboundAt\(/)
    expect(indexTs).toMatch(/const leerLaBaseParaLaSalud = unaVezCada\(2_000,/)
  })

  it('y sigue sin limitador: Railway la usa para saber si el contenedor vive', () => {
    // Un 429 aquí sería, para Railway, un contenedor muerto: reinicio en bucle.
    expect(indexTs).not.toMatch(/app\.use\('\/api\/health',/)
  })
})

describe('el servidor no espera para siempre a un cliente lento', () => {
  it('20 s para las cabeceras; la petición entera conserva su margen para subidas lentas', () => {
    const servidor = createServer()
    ajustarTiemposDeEspera(servidor)
    expect(servidor.headersTimeout).toBe(ESPERA_DE_CABECERAS_MS)
    expect(ESPERA_DE_CABECERAS_MS).toBe(20_000)
    expect(servidor.requestTimeout).toBe(ESPERA_DE_LA_PETICION_MS)
    // Node exige que las cabeceras no tengan MÁS tiempo que la petición entera.
    expect(servidor.headersTimeout).toBeLessThan(servidor.requestTimeout)
  })

  it('se aplica al servidor que de verdad abre el puerto', () => {
    const abrir = indexTs.indexOf('httpServer = app.listen(port, alAbrirElPuerto)')
    expect(abrir).toBeGreaterThan(-1)
    expect(indexTs.slice(abrir, abrir + 200)).toContain('ajustarTiemposDeEspera(httpServer)')
  })
})
