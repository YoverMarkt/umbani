import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import express from 'express'
import rateLimit from 'express-rate-limit'
import { PROXIES_DE_CONFIANZA } from '../dist/config/ip-del-cliente.js'

// ═══════════════════════════════════════════════════════════════════════════
// LOS FRENOS CUENTAN POR CLIENTE, NO POR NODO DE RAILWAY (2026-10-08)
// ═══════════════════════════════════════════════════════════════════════════
//
// El borde de Railway deja `X-Forwarded-For: <cliente>, <nodo 100.x>`. Con
// `trust proxy 1`, `req.ip` era el NODO: una sola IP vio dos contadores en el
// staging. Ver `src/config/ip-del-cliente.ts`.
//
// Express de verdad, en un puerto local: el socket de 127.0.0.1 hace de proxy
// interno de Railway, y la cabecera, de lo que deja su borde.

const CLIENTE = '190.12.34.56'
const NODO_A = '100.64.0.7'
const NODO_B = '100.96.1.2'

const servidores = []
async function montar(confianza) {
  const app = express()
  app.set('trust proxy', confianza)
  app.get('/ip', (req, res) => res.json({ ip: req.ip }))
  app.get('/frenado', rateLimit({ windowMs: 60_000, max: 50, standardHeaders: true, legacyHeaders: false }),
    (req, res) => res.json({ ip: req.ip }))
  const servidor = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  servidores.push(servidor)
  const base = `http://127.0.0.1:${servidor.address().port}`
  return async (xff, ruta = '/ip') => {
    const r = await fetch(`${base}${ruta}`, { headers: xff ? { 'x-forwarded-for': xff } : {} })
    return { ...(await r.json()), restantes: Number(r.headers.get('ratelimit-remaining')) }
  }
}

let ahora
let antes
beforeAll(async () => {
  ahora = await montar(PROXIES_DE_CONFIANZA)
  antes = await montar(1)
})
afterAll(() => Promise.all(servidores.map(s => new Promise(r => s.close(r)))))

describe('detrás de Railway, el cliente es el cliente', () => {
  it('la IP es la del cliente, no la del nodo (con `1` salía el nodo)', async () => {
    expect((await ahora(`${CLIENTE}, ${NODO_A}`)).ip).toBe(CLIENTE)
    // El fallo, escrito para que no vuelva: así contaba producción.
    expect((await antes(`${CLIENTE}, ${NODO_A}`)).ip).toBe(NODO_A)
  })

  it('pase por el nodo que pase, el cliente tiene UN contador', async () => {
    const restantes = []
    for (const nodo of [NODO_A, NODO_B, NODO_A, NODO_B]) {
      restantes.push((await ahora(`${CLIENTE}, ${nodo}`, '/frenado')).restantes)
    }
    expect(restantes).toEqual([49, 48, 47, 46])

    // Con `1`, dos contadores intercalados: lo que se midió en el staging.
    const antesRestantes = []
    for (const nodo of [NODO_A, NODO_B, NODO_A, NODO_B]) {
      antesRestantes.push((await antes(`${CLIENTE}, ${nodo}`, '/frenado')).restantes)
    }
    expect(antesRestantes).toEqual([49, 49, 48, 48])
  })

  it('y dos clientes que pasan por el mismo nodo NO comparten freno', async () => {
    const uno = await ahora(`181.199.1.1, ${NODO_A}`, '/frenado')
    const otro = await ahora(`181.199.2.2, ${NODO_A}`, '/frenado')
    expect([uno.restantes, otro.restantes]).toEqual([49, 49])
  })
})

describe('falla hacia lo seguro', () => {
  it('una IP inventada delante del cliente no cuela (si el borde dejara de reescribir)', async () => {
    expect((await ahora(`203.0.113.9, ${CLIENTE}, ${NODO_A}`)).ip).toBe(CLIENTE)
  })

  it('si Railway cambiara de rango, se cuenta por nodo —lo de antes—, nunca por lo que diga el cliente', async () => {
    expect((await ahora(`${CLIENTE}, 152.233.23.193`)).ip).toBe('152.233.23.193')
  })

  it('nunca confía en todo: con `true` mandaría la entrada que escribe quien ataca', () => {
    expect(Array.isArray(PROXIES_DE_CONFIANZA)).toBe(true)
    expect(PROXIES_DE_CONFIANZA).not.toContain('0.0.0.0/0')
    expect(PROXIES_DE_CONFIANZA).not.toContain('::/0')
  })
})

describe('lo de siempre sigue igual', () => {
  it('los recorridos, cada archivo desde su red 10.x, siguen contando aparte', async () => {
    expect((await ahora('10.4.5.6')).ip).toBe('10.4.5.6')
  })

  it('sin cabecera, la IP es la de la conexión', async () => {
    expect((await ahora()).ip).toBe('127.0.0.1')
  })
})

describe('guardián: el servidor de verdad usa esta lista', () => {
  it('index.ts confía en PROXIES_DE_CONFIANZA, no en un número de saltos', () => {
    const indexTs = readFileSync('src/index.ts', 'utf8')
    expect(indexTs).toContain("app.set('trust proxy', PROXIES_DE_CONFIANZA)")
    expect(indexTs.match(/app\.set\('trust proxy'/g)).toHaveLength(1)
  })
})
