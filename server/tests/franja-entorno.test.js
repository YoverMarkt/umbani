import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const franja = require('../dist/lib/franja-entorno')

// ═══════════════════════════════════════════════════════════════════════════
// LA FRANJA DE ENTORNO
// ═══════════════════════════════════════════════════════════════════════════
//
// Nace de una pregunta del dueño: «¿cómo sé cuándo se está en local y cuándo ya
// está todo en producción?».
//
// Lo que se prueba aquí, por orden de importancia:
//
//   1. que en PRODUCCIÓN no aparezca jamás — una etiqueta de pruebas encima de
//      la tienda de verdad la vería un cliente pagando;
//   2. que avise en ROJO cuando la máquina local apunta a la base real, que es
//      la situación peligrosa de verdad.

const PRODUCCION = 'https://isepwpmwdajavmbnsckc.supabase.co'
const LOCAL = 'http://127.0.0.1:54321'

describe('en producción no se pinta nada', () => {
  it('con NODE_ENV=production no hay aviso', () => {
    expect(franja.avisoDeEntorno({ NODE_ENV: 'production', SUPABASE_URL: PRODUCCION }))
      .toBeNull()
  })

  it('en Railway tampoco', () => {
    for (const entorno of [
      { BASE_URL: 'https://web-production-3433c.up.railway.app' },
      { RAILWAY_ENVIRONMENT: 'production' },
      { RAILWAY_ENVIRONMENT_NAME: 'production' },
    ]) {
      expect(franja.avisoDeEntorno({ ...entorno, SUPABASE_URL: PRODUCCION })).toBeNull()
    }
  })
})

describe('una BASE_URL local no apaga la franja', () => {
  it('con BASE_URL a localhost sigue diciendo STAGING', () => {
    // El staging necesita BASE_URL para armar el enlace de la tienda. Si eso
    // apagara la etiqueta, la copia con datos falsos se vería igual que la
    // tienda de verdad — que es exactamente lo que la franja viene a evitar.
    const aviso = franja.avisoDeEntorno({
      BASE_URL: 'http://localhost:3100',
      SUPABASE_URL: LOCAL,
    })
    expect(aviso).not.toBeNull()
    expect(aviso.texto).toContain('STAGING')
  })
})

describe('fuera de producción, la etiqueta dice cuál de los dos casos es', () => {
  it('base local: staging, datos de mentira', () => {
    const aviso = franja.avisoDeEntorno({ SUPABASE_URL: LOCAL })
    expect(aviso.texto).toContain('STAGING')
    expect(aviso.texto).toContain('mentira')
  })

  it('base REAL desde local: el aviso importante, y en rojo', () => {
    const aviso = franja.avisoDeEntorno({ SUPABASE_URL: PRODUCCION })
    expect(aviso.texto).toContain('BASE REAL')
    // Rojo, distinto del índigo de staging: de un vistazo, sin leer.
    expect(aviso.color).toBe('#b91c1c')
    expect(aviso.color).not.toBe(franja.avisoDeEntorno({ SUPABASE_URL: LOCAL }).color)
  })
})

describe('cómo entra en la página', () => {
  const aviso = { texto: 'STAGING · datos de mentira', color: '#4338ca' }

  it('va justo antes de cerrar el body', () => {
    const html = '<html><body><div id="root"></div></body></html>'
    const resultado = franja.inyectarFranja(html, aviso)
    expect(resultado.indexOf('STAGING')).toBeLessThan(resultado.indexOf('</body>'))
    expect(resultado).toContain('<div id="root"></div>')
  })

  it('no se come un clic de la aplicación', () => {
    // Una etiqueta flotante que capture eventos taparía un botón real.
    expect(franja.franjaHtml(aviso)).toContain('pointer-events:none')
  })

  it('si no hay </body>, la etiqueta se pone igual', () => {
    // Mejor una etiqueta mal colocada que una página sin aviso.
    expect(franja.inyectarFranja('<div>hola</div>', aviso)).toContain('STAGING')
  })

  it('el HTML original no se pierde por el camino', () => {
    const html = '<html><head><title>Umbani</title></head><body><main>x</main></body></html>'
    const resultado = franja.inyectarFranja(html, aviso)
    expect(resultado).toContain('<title>Umbani</title>')
    expect(resultado).toContain('<main>x</main>')
  })
})

describe('guardián: la franja está ENCHUFADA al HTML que se sirve', () => {
  const fuente = readFileSync(new URL('../src/lib/cache-estaticos.ts', import.meta.url), 'utf8')

  it('enviarHtmlDeSpa la consulta', () => {
    expect(fuente).toContain('avisoDeEntorno(process.env)')
    expect(fuente).toContain('inyectarFranja')
  })

  it('y en producción sigue yendo por sendFile', () => {
    // Si alguien quitara este atajo, producción leería el índice del disco en
    // cada visita y perdería su ETag, a cambio de nada.
    const trozo = fuente.slice(fuente.indexOf('const aviso = avisoDeEntorno'))
    expect(trozo).toMatch(/if \(!aviso\) \{\s*\n\s*response\.sendFile\(htmlPath\)/)
  })
})

describe('guardián: las RAÍCES de los paneles también pasan por la función', () => {
  const arranque = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

  it('/app, /app-admin y /cooperativa se declaran antes que su express.static', () => {
    // `express.static` sirve él mismo el index.html de la carpeta, sin pasar
    // por `enviarHtmlDeSpa`. El comodín `/app/*` NO casa con `/app`, así que
    // sin la ruta explícita —y antes del static— la portada de los dos paneles
    // se queda fuera. Se descubrió porque la franja salía en la tienda (donde
    // `/t/<slug>` nunca casa con un archivo) y no en los paneles.
    for (const base of ['/app', '/app-admin', '/cooperativa']) {
      const raiz = arranque.indexOf(`app.get('${base}', (_req, res) => enviarHtmlDeSpa`)
      const estatico = arranque.indexOf(`app.use('${base}', express.static`)
      expect(raiz, `falta la ruta explícita de ${base}`).toBeGreaterThan(-1)
      expect(estatico).toBeGreaterThan(-1)
      expect(raiz, `${base} se declara DESPUÉS de su static`).toBeLessThan(estatico)
    }
  })
})
