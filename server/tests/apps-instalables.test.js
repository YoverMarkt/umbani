import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'

const require = createRequire(import.meta.url)
const { APPS_INSTALABLES, montarAppsInstalables } = require('../dist/lib/apps-instalables')

// ═══════════════════════════════════════════════════════════════════════════
// LAS APPS INSTALABLES: EL SERVICE WORKER LLEGA COMO SERVICE WORKER
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo que se vigila es invisible: si `/u/sw.js` respondiera la PÁGINA de la app
// —que es lo que hace el comodín `/u/*` con cualquier cosa—, la app seguiría
// abriendo igual y simplemente dejaría de poder instalarse. Ni un error en
// pantalla, ni uno en el registro.

const SW = '// el service worker de prueba\n'
let carpeta
let servidor
let base

beforeAll(async () => {
  carpeta = mkdtempSync(path.join(tmpdir(), 'apps-instalables-'))
  writeFileSync(path.join(carpeta, 'sw.js'), SW)
  const app = express()
  montarAppsInstalables(app, carpeta)
  // Los comodines de `index.ts`, montados DESPUÉS, como allí.
  app.get(['/u', '/u/*'], (_req, res) => res.type('html').send('<title>Umbani</title>'))
  app.get(['/r', '/r/*'], (_req, res) => res.type('html').send('<title>Umbani Repartidores</title>'))
  await new Promise((resolve) => { servidor = app.listen(0, resolve) })
  base = `http://127.0.0.1:${servidor.address().port}`
})

afterAll(async () => {
  await new Promise(resolve => servidor.close(resolve))
  rmSync(carpeta, { recursive: true, force: true })
})

describe('el service worker de cada app', () => {
  it('son las dos apps web, y solo esas', () => {
    expect([...APPS_INSTALABLES]).toEqual(['/u', '/r'])
  })

  for (const alcance of ['/u', '/r']) {
    it(`${alcance}/sw.js llega como JavaScript, con permiso para controlar ${alcance}`, async () => {
      const respuesta = await fetch(`${base}${alcance}/sw.js`)
      expect(respuesta.status).toBe(200)
      expect(respuesta.headers.get('content-type')).toMatch(/javascript/)
      // Sin esta cabecera el navegador solo le dejaría controlar `/u/`, y la
      // app instalada abre `/u`.
      expect(respuesta.headers.get('service-worker-allowed')).toBe(alcance)
      expect(respuesta.headers.get('cache-control')).toBe('no-cache')
      expect(await respuesta.text()).toBe(SW)
    })
  }

  it('el resto de la app sigue llegando a su página', async () => {
    const respuesta = await fetch(`${base}/u/pedidos`)
    expect(await respuesta.text()).toContain('<title>Umbani</title>')
  })
})

describe('index.ts las monta antes que los comodines', () => {
  // La prueba de arriba monta en el orden correcto a mano; esta mira que
  // `index.ts` lo haga igual. Construido y desconectado es el fallo que más
  // veces se ha repetido en este proyecto (skill `camino-real`).
  const indice = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

  it('las rutas del service worker van antes que /u/* y /r/*', () => {
    const montaje = indice.indexOf('montarAppsInstalables(app, storeDist)')
    expect(montaje).toBeGreaterThan(-1)
    expect(montaje).toBeLessThan(indice.indexOf("app.get(['/u', '/u/*']"))
    expect(montaje).toBeLessThan(indice.indexOf("app.get(['/r', '/r/*']"))
  })
})
