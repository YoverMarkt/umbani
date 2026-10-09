import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import express from 'express'
import rateLimit from 'express-rate-limit'
import {
  PROXIES_DE_CONFIANZA, crearClienteSegunRailway, vieneDelProxyDeRailway,
} from '../dist/middleware/ip-del-cliente.js'
import { RANGOS_DE_CLOUDFLARE, esDeCloudflare } from '../dist/lib/rangos-de-cloudflare.js'

// ═══════════════════════════════════════════════════════════════════════════
// LOS FRENOS CUENTAN POR CLIENTE, NO POR NODO DE RAILWAY (2026-10-08)
// ═══════════════════════════════════════════════════════════════════════════
//
// La cadena que llega de verdad, medida con un diagnóstico en el staging:
//   conexión ::ffff:100.64.0.x · X-Forwarded-For «<cliente>, 152.233.23.19x»
//   (su borde, una CDN) · X-Real-IP «<cliente>»
// Ver `src/middleware/ip-del-cliente.ts`.
//
// Express de verdad, en un puerto local. La conexión llega de 127.0.0.1, así
// que «viene de Railway» se finge donde hace falta; lo que decide si una
// conexión ES de Railway se prueba aparte, con sus direcciones reales.

const CLIENTE = '190.12.34.56'
const CDN_A = '152.233.23.193'
const CDN_B = '152.233.23.194'
const deRailway = (cliente, nodo) => ({ 'x-forwarded-for': `${cliente}, ${nodo}`, 'x-real-ip': cliente })

const servidores = []
async function montar({ confianza = PROXIES_DE_CONFIANZA, middleware = null } = {}) {
  const app = express()
  app.set('trust proxy', confianza)
  if (middleware) app.use(middleware)
  app.get('/ip', (req, res) => res.json({ ip: req.ip }))
  app.get('/frenado', rateLimit({ windowMs: 60_000, max: 50, standardHeaders: true, legacyHeaders: false }),
    (req, res) => res.json({ ip: req.ip }))
  const servidor = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  servidores.push(servidor)
  const base = `http://127.0.0.1:${servidor.address().port}`
  return async (cabeceras = {}, ruta = '/ip') => {
    const r = await fetch(`${base}${ruta}`, { headers: cabeceras })
    return { ...(await r.json()), restantes: Number(r.headers.get('ratelimit-remaining')) }
  }
}

let ahora // el servidor como queda: la lista + X-Real-IP, con la conexión fingida de Railway
let real // el middleware de verdad, que mira la conexión (aquí, 127.0.0.1: no es Railway)
let antes // `trust proxy 1`, lo que había
let soloLista // el primer intento: la lista sin X-Real-IP (no bastó en el staging)
let conCloudflare // el de `ahora`, con los rangos de Cloudflare de verdad y los avisos a mano
const avisos = []
beforeAll(async () => {
  ahora = await montar({ middleware: crearClienteSegunRailway(() => true) })
  real = await montar({ middleware: crearClienteSegunRailway() })
  antes = await montar({ confianza: 1 })
  soloLista = await montar()
  conCloudflare = await montar({ middleware: crearClienteSegunRailway(() => true, esDeCloudflare, (borde) => avisos.push(borde)) })
})
afterAll(() => Promise.all(servidores.map(s => new Promise(r => s.close(r)))))

describe('detrás de Railway, el cliente es el cliente', () => {
  it('la IP es la del cliente, no la del nodo del borde', async () => {
    expect((await ahora(deRailway(CLIENTE, CDN_A))).ip).toBe(CLIENTE)
    // El fallo, escrito para que no vuelva: así contaba producción…
    expect((await antes(deRailway(CLIENTE, CDN_A))).ip).toBe(CDN_A)
    // …y así se quedó el primer intento: el nodo de la CDN no es de 100.x.
    expect((await soloLista(deRailway(CLIENTE, CDN_A))).ip).toBe(CDN_A)
  })

  it('pase por el nodo que pase, el cliente tiene UN contador', async () => {
    const restantes = []
    for (const nodo of [CDN_A, CDN_B, CDN_A, CDN_B]) {
      restantes.push((await ahora(deRailway(CLIENTE, nodo), '/frenado')).restantes)
    }
    expect(restantes).toEqual([49, 48, 47, 46])

    // Con `1`, dos contadores intercalados: lo que se midió en el staging.
    const antesRestantes = []
    for (const nodo of [CDN_A, CDN_B, CDN_A, CDN_B]) {
      antesRestantes.push((await antes(deRailway(CLIENTE, nodo), '/frenado')).restantes)
    }
    expect(antesRestantes).toEqual([49, 49, 48, 48])
  })

  it('y dos clientes que pasan por el mismo nodo NO comparten freno', async () => {
    const uno = await ahora(deRailway('181.199.1.1', CDN_A), '/frenado')
    const otro = await ahora(deRailway('181.199.2.2', CDN_A), '/frenado')
    expect([uno.restantes, otro.restantes]).toEqual([49, 49])
  })

  it('sin X-Real-IP, por la red de Railway la lista sigue sacando al cliente', async () => {
    expect((await ahora({ 'x-forwarded-for': `${CLIENTE}, 100.64.0.7` })).ip).toBe(CLIENTE)
  })
})

describe('falla hacia lo seguro', () => {
  it('un X-Real-IP que NO llega por Railway no vale: no sirve para saltarse un freno', async () => {
    // `real` mira la conexión de verdad (127.0.0.1): no es Railway.
    expect((await real({ 'x-real-ip': '203.0.113.77' })).ip).toBe('127.0.0.1')
  })

  it('lo que no es una IP en X-Real-IP se ignora', async () => {
    for (const basura of ['no-soy-una-ip', `${CLIENTE}, 1.2.3.4`, '']) {
      expect((await ahora({ 'x-real-ip': basura })).ip, basura).toBe('127.0.0.1')
    }
  })

  it('nunca confía en todo: con `true` mandaría la entrada que escribe quien ataca', () => {
    expect(Array.isArray(PROXIES_DE_CONFIANZA)).toBe(true)
    expect(PROXIES_DE_CONFIANZA).not.toContain('0.0.0.0/0')
    expect(PROXIES_DE_CONFIANZA).not.toContain('::/0')
  })
})

describe('qué conexión es de Railway', () => {
  it('su red (100.x), también escrita como IPv6, y nada más', () => {
    for (const si of ['::ffff:100.64.0.1', '100.64.0.9', '100.0.0.1']) expect(vieneDelProxyDeRailway(si), si).toBe(true)
    for (const no of ['127.0.0.1', '::1', '10.0.0.1', '152.233.23.193', '::ffff:10.0.0.1', '1000.1.1.1', '', undefined]) {
      expect(vieneDelProxyDeRailway(no), String(no)).toBe(false)
    }
  })
})

describe('lo de siempre sigue igual', () => {
  it('los recorridos, cada archivo desde su red 10.x, siguen contando aparte', async () => {
    expect((await real({ 'x-forwarded-for': '10.4.5.6' })).ip).toBe('10.4.5.6')
  })

  it('sin cabeceras, la IP es la de la conexión', async () => {
    expect((await real()).ip).toBe('127.0.0.1')
  })
})

// ── Con Cloudflare delante (preparado el 2026-10-09, para el dominio) ──────
//
// Lo que verá Railway: la conexión de su proxy (100.x), `X-Real-IP` = un NODO
// de Cloudflare, y el cliente en `CF-Connecting-IP`.
const NODO_CF_A = '104.16.12.34'
const NODO_CF_B = '172.70.1.2'
const porCloudflare = (cliente, nodo = NODO_CF_A) => ({
  'x-forwarded-for': `${cliente}, ${nodo}`,
  'x-real-ip': nodo,
  'cf-connecting-ip': cliente,
})

describe('con Cloudflare delante, el cliente sigue siendo el cliente', () => {
  it('la IP es la que dice Cloudflare, no la de su nodo', async () => {
    expect((await conCloudflare(porCloudflare(CLIENTE))).ip).toBe(CLIENTE)
    // Sin esto, el domingo: todos los que pasan por el nodo, una sola IP.
    expect((await ahora({ 'x-real-ip': NODO_CF_A })).ip).toBe(NODO_CF_A)
  })

  it('pase por el nodo que pase, el cliente tiene UN contador', async () => {
    const restantes = []
    for (const nodo of [NODO_CF_A, NODO_CF_B, NODO_CF_A]) {
      restantes.push((await conCloudflare(porCloudflare('181.39.7.7', nodo), '/frenado')).restantes)
    }
    expect(restantes).toEqual([49, 48, 47])
  })

  it('y dos clientes del mismo nodo NO comparten freno', async () => {
    const uno = await conCloudflare(porCloudflare('181.39.8.1'), '/frenado')
    const otro = await conCloudflare(porCloudflare('181.39.8.2'), '/frenado')
    expect([uno.restantes, otro.restantes]).toEqual([49, 49])
  })

  it('también con un cliente en IPv6', async () => {
    expect((await conCloudflare(porCloudflare('2800:bf0:8000::1'))).ip).toBe('2800:bf0:8000::1')
  })
})

describe('con Cloudflare delante, falla hacia lo seguro', () => {
  it('quien le habla a Railway directo NO se cambia la IP inventando CF-Connecting-IP', async () => {
    avisos.length = 0
    const atacante = '203.0.113.9'
    const r = await conCloudflare({ 'x-real-ip': atacante, 'cf-connecting-ip': '181.39.9.9' })
    expect(r.ip).toBe(atacante)
    // Y queda en el registro: con Cloudflare delante, sería una red que falta en la lista.
    expect(avisos).toEqual([atacante])
  })

  it('un nodo de Cloudflare sin CF-Connecting-IP cuenta como el nodo (peor, pero nunca por lo que diga el cliente)', async () => {
    expect((await conCloudflare({ 'x-real-ip': NODO_CF_A })).ip).toBe(NODO_CF_A)
  })

  it('lo que no es UNA IP en CF-Connecting-IP se ignora', async () => {
    for (const basura of ['no-soy-una-ip', `${CLIENTE}, 1.2.3.4`, '   ']) {
      expect((await conCloudflare({ 'x-real-ip': NODO_CF_A, 'cf-connecting-ip': basura })).ip, basura).toBe(NODO_CF_A)
    }
  })

  it('sin la conexión de Railway, CF-Connecting-IP no cuenta', async () => {
    // `real` mira la conexión de verdad (127.0.0.1): no es Railway.
    expect((await real({ 'x-real-ip': NODO_CF_A, 'cf-connecting-ip': CLIENTE })).ip).toBe('127.0.0.1')
  })

  it('el aviso sale UNA vez por hora como mucho: un ataque no inunda el registro', async () => {
    const consola = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const conAvisoDeVerdad = await montar({ middleware: crearClienteSegunRailway(() => true) })
      for (let i = 0; i < 3; i++) await conAvisoDeVerdad({ 'x-real-ip': '203.0.113.10', 'cf-connecting-ip': '181.39.9.9' })
      expect(consola).toHaveBeenCalledTimes(1)
      expect(String(consola.mock.calls[0][0])).toContain('203.0.113.10')
    } finally {
      consola.mockRestore()
    }
  })
})

describe('qué dirección es de Cloudflare', () => {
  it('la lista es la publicada: 15 redes IPv4 y 7 IPv6', () => {
    expect(RANGOS_DE_CLOUDFLARE.filter((r) => r.includes('.'))).toHaveLength(15)
    expect(RANGOS_DE_CLOUDFLARE.filter((r) => r.includes(':'))).toHaveLength(7)
  })

  it('la primera dirección de cada red es de Cloudflare', () => {
    for (const rango of RANGOS_DE_CLOUDFLARE) {
      const red = rango.split('/')[0]
      expect(esDeCloudflare(red.endsWith('::') ? `${red}1` : red), rango).toBe(true)
    }
  })

  it('también escrita como IPv6, y nada más', () => {
    for (const si of ['::ffff:104.16.12.34', '2606:4700::6810:1', '172.70.1.2']) expect(esDeCloudflare(si), si).toBe(true)
    // 1.1.1.1 es su DNS, no su red de proxy; 104.28.x, la salida de WARP; 152.233.x, el borde de Railway.
    for (const no of ['1.1.1.1', '104.28.0.1', '152.233.23.193', '100.64.0.1', '190.12.34.56', '2800:bf0::1', 'basura', '', undefined]) {
      expect(esDeCloudflare(no), String(no)).toBe(false)
    }
  })
})

describe('guardián: el servidor de verdad lo usa, y antes que nada', () => {
  const indexTs = readFileSync('src/index.ts', 'utf8')

  it('index.ts confía en la lista, no en un número de saltos', () => {
    expect(indexTs).toContain("app.set('trust proxy', PROXIES_DE_CONFIANZA)")
    expect(indexTs.match(/app\.set\('trust proxy'/g)).toHaveLength(1)
  })

  it('y el primer middleware es el que reduce la cadena: ningún freno cuenta antes', () => {
    const primero = indexTs.match(/^app\.use\(([^)\n]*)/m)
    expect(primero?.[1]).toBe('clienteSegunRailway')
  })
})
