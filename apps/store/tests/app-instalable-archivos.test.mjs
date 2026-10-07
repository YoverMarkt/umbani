import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════════
// LAS APPS INSTALABLES TIENEN TODO LO QUE PIDE EL TELÉFONO (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Si a la ficha le falta un icono, o el icono no mide lo que dice, el teléfono
// no falla: simplemente deja de ofrecer instalar la app, sin decir por qué.
// Por eso se comprueba aquí, archivo por archivo. En `.mjs`, como las demás
// pruebas que leen archivos.

const leer = ruta => readFileSync(new URL(`../${ruta}`, import.meta.url), 'utf8')
/** Lo que el servidor sirve en `/t/…` sale de `public/`. */
const enPublic = url => new URL(`../public/${url.replace(/^\/t\//, '')}`, import.meta.url)

/** Ancho y alto de un PNG, leídos de su cabecera. */
function medidas(url) {
  const png = readFileSync(enPublic(url))
  expect(png.subarray(1, 4).toString('latin1'), `${url} no es un PNG`).toBe('PNG')
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`
}

const APPS = [
  { pagina: 'u.html', ficha: '/t/u.webmanifest', inicio: '/u', main: 'src/umbani/main.tsx' },
  { pagina: 'r.html', ficha: '/t/r.webmanifest', inicio: '/r', main: 'src/repartidor/main.tsx' },
]

for (const app of APPS) {
  describe(`la app ${app.inicio}`, () => {
    const pagina = leer(app.pagina)
    const ficha = JSON.parse(readFileSync(enPublic(app.ficha), 'utf8'))

    it('su página enlaza su ficha y el icono del iPhone', () => {
      expect(pagina).toContain(`<link rel="manifest" href="${app.ficha}" />`)
      const icono = pagina.match(/<link rel="apple-touch-icon" href="([^"]+)"/)?.[1]
      expect(icono).toBeTruthy()
      // El iPhone pide 180 × 180 y pinta de negro lo transparente.
      expect(medidas(icono)).toBe('180x180')
    })

    it('la ficha abre la app a pantalla completa, desde su dirección', () => {
      expect(ficha.name).toBeTruthy()
      expect(ficha.short_name.length).toBeLessThanOrEqual(12)
      expect(ficha.display).toBe('standalone')
      expect(ficha.start_url).toBe(app.inicio)
      expect(ficha.id).toBe(app.inicio)
      // Si el inicio cae fuera del alcance, el navegador descarta la ficha.
      expect(app.inicio.startsWith(ficha.scope)).toBe(true)
    })

    it('lleva los iconos que piden Android y Chrome, y miden lo que dicen', () => {
      for (const icono of ficha.icons) {
        expect(existsSync(enPublic(icono.src)), icono.src).toBe(true)
        expect(medidas(icono.src)).toBe(icono.sizes)
      }
      const con = (tamano, uso) => ficha.icons.some(i => i.sizes === tamano && i.purpose === uso)
      expect(con('192x192', 'any')).toBe(true)
      expect(con('512x512', 'any')).toBe(true)
      expect(con('512x512', 'maskable')).toBe(true)
    })

    it('registra su service worker con el alcance de su ficha', () => {
      expect(leer(app.main)).toContain(`registrarLaApp('${app.inicio}')`)
    })
  })
}

describe('la app de clientes cubre la tienda y la vuelta del pago', () => {
  it('su alcance es la raíz, no solo /u', () => {
    // Para pagar, `/u` salta a la tienda (`/t/<local>`) y PayPhone vuelve a
    // `/pagos/…`. Con alcance `/u`, al pagar se saldría de la app instalada.
    expect(JSON.parse(readFileSync(enPublic('/t/u.webmanifest'), 'utf8')).scope).toBe('/')
  })
})

describe('el service worker no guarda nada que deba salir del servidor', () => {
  const sw = leer('public/sw.js')

  it('solo atiende pantallas: la API va siempre a la red', () => {
    expect(sw).toMatch(/if \(evento\.request\.mode !== 'navigate'\) return/)
  })

  it('no guarda respuestas: solo la pantalla «Sin conexión»', () => {
    // Un `put` guardaría lo que responde el servidor —un precio, un pedido—
    // y lo enseñaría viejo.
    expect(sw).not.toMatch(/\.put\(/)
    const sinRed = sw.match(/const SIN_RED = '([^']+)'/)?.[1]
    expect(existsSync(enPublic(sinRed)), sinRed).toBe(true)
  })

  it('la pantalla «Sin conexión» no depende de nada que haya que descargar', () => {
    const sinRed = leer('public/sin-conexion.html')
    expect(sinRed).not.toMatch(/<script/i)
    expect(sinRed).not.toMatch(/(src|href)="https?:/)
  })
})
