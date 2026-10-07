import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { fuenteDeLaTienda } from './fuente-de-rutas.mjs'
import { router, rutas } from './manejadores-de-la-tienda.mjs'

// Guardián de las rutas de la mini app.
//
// Son las ÚNICAS rutas públicas del proyecto: no llevan JWT, la credencial es
// el enlace que mandó el bot. Una ruta añadida aquí sin `requireStorefrontSession`
// deja la tienda abierta a cualquiera, así que se comprueba una por una.


// Tres rutas viven sin `requireStorefrontSession`, y cada una por su motivo:
//  · la portada, que es lo que ve quien no tiene enlace;
//  · el enlace corto, que NO devuelve datos — solo redirige. Con un token
//    inventado no se averigua nada, y quien llega con el suyo ya lo tenía;
//  · la verificación del número, que no PUEDE llevar el middleware: rechaza
//    justo el estado en el que se llega a ella ('necesita_telefono'). Es la
//    puerta, no una habitación.
const PUBLICA = '/api/store/:slug'
const ENLACE_CORTO = '/s/:code'
const VERIFICACION = '/api/store/:slug/session/verify'
const CATALOGO = '/api/store/:slug/catalog'
const SIN_SESION = [PUBLICA, ENLACE_CORTO, VERIFICACION]
// El catálogo es público: se ve sin enlace. Va aparte de `SIN_SESION` porque sí
// lleva middleware —`readStorefrontSession`, que reclama el dispositivo cuando
// el enlace SÍ viene— y contarlo con los demás lo daría por protegido.
const COTIZAR = '/api/store/:slug/quote'
const PUBLICAS = [...SIN_SESION, CATALOGO, COTIZAR]

describe('rutas de la mini app', () => {
  it('expone las rutas esperadas y ninguna más', () => {
    // Sin duplicar: `/orders` existe dos veces —GET para la lista de la Cuenta
    // y POST para crear— y son la misma ruta con dos verbos.
    expect([...new Set(rutas.map(r => r.path))].sort()).toEqual([
      '/api/store/:slug',
      '/api/store/:slug/addresses',
      '/api/store/:slug/addresses/:id',
      '/api/store/:slug/addresses/:id/location',
      '/api/store/:slug/catalog',
      '/api/store/:slug/me',
      '/api/store/:slug/orders',
      '/api/store/:slug/orders/:id',
      '/api/store/:slug/orders/:id/proof',
      // Pagar con tarjeta (POST) y preguntar en qué quedó el cobro (GET).
      '/api/store/:slug/orders/:id/tarjeta',
      // «¿Llegó todo bien?» (2026-10-06): decir «todo bien» o reclamar.
      '/api/store/:slug/orders/:id/todo-bien',
      '/api/store/:slug/orders/:id/reclamo',
      '/api/store/:slug/payment-info',
      '/api/store/:slug/quote',
      '/api/store/:slug/session/verify',
      '/s/:code',
    ].sort())
  })

  // Si alguien añade una ruta y olvida el middleware, este test lo caza.
  it('toda ruta salvo las públicas exige sesión del enlace', () => {
    const sinProteger = rutas
      .filter(ruta => !PUBLICAS.includes(ruta.path) && ruta.handlers < 2)
      .map(ruta => ruta.path)
    expect(sinProteger).toEqual([])
  })

  // Contar middlewares no basta: `readStorefrontSession` también cuenta como
  // uno, y el catálogo pasaría por protegido sin estarlo. Aquí se mira CUÁL
  // lleva cada ruta, que es lo que de verdad decide quién entra.
  //
  // La distinción es la que sostiene el catálogo público: mirar la carta no
  // pide enlace; crear un pedido, ver direcciones o el perfil, sí.
  it('cada ruta lleva el middleware que le toca, no uno cualquiera', () => {
    const fuente = fuenteDeLaTienda({ compilado: true })
    const middlewareDe = (path) => {
      const desde = fuente.indexOf(`'${path}'`)
      expect(desde, `no se encontró la ruta ${path}`).toBeGreaterThan(-1)
      const linea = fuente.slice(desde, fuente.indexOf('\n', desde))
      if (linea.includes('requireStorefrontSession')) return 'exige'
      if (linea.includes('readStorefrontSession')) return 'opcional'
      return 'ninguno'
    }

    // El catálogo se ve sin enlace, y cotizar tampoco lo pide: no crea nada,
    // solo dice cuánto costaría. Crear el pedido sí.
    expect(middlewareDe(CATALOGO)).toBe('opcional')
    expect(middlewareDe(COTIZAR)).toBe('opcional')

    // Todo lo que escribe o devuelve datos de una PERSONA lo sigue exigiendo.
    for (const path of [
      '/api/store/:slug/me',
      '/api/store/:slug/addresses',
      '/api/store/:slug/addresses/:id',
      '/api/store/:slug/addresses/:id/location',
      '/api/store/:slug/orders',
      '/api/store/:slug/orders/:id',
      '/api/store/:slug/orders/:id/proof',
      // Cobrar con tarjeta ES dinero de una persona: con sesión, siempre.
      '/api/store/:slug/orders/:id/tarjeta',
      // Y reclamar lo es también: con sesión, y del pedido de ESA sesión.
      '/api/store/:slug/orders/:id/todo-bien',
      '/api/store/:slug/orders/:id/reclamo',
      '/api/store/:slug/payment-info',
    ]) {
      expect(middlewareDe(path), path).toBe('exige')
    }
  })

  // La garantía que hace que abrir el catálogo no abra nada más: el middletware
  // opcional deja el negocio en `storeBusinessId` y el cliente SOLO en
  // `storefront`. Si el negocio sin sesión entrara en `storefront`, una ruta
  // que lea `storefront.customerId` crearía un pedido sin cliente.
  it('el catálogo público no puede dejar una sesión a medias', () => {
    const fuente = fs.readFileSync('dist/middleware/storefront.js', 'utf8')
    const bloque = fuente.slice(fuente.indexOf('readStorefrontSession'))
    expect(bloque).toContain('storeBusinessId')
    // Solo se asigna `storefront` cuando hay sesión completa.
    expect(bloque).toMatch(/if \(session\)\s*req\.storefront = session/)
  })

  it('el enlace corto no lleva NADA delante: es solo una redirección', () => {
    const ruta = rutas.find(r => r.path === ENLACE_CORTO)
    expect(ruta).toBeTruthy()
    expect(ruta.handlers).toBe(1)
  })

  /**
   * La PORTADA lleva dos handlers desde el 2026-08-29, y el segundo es
   * `readStorefrontBlock`. No es una sesión: no rechaza a nadie ni exige
   * token — solo mira si quien abre está BLOQUEADO, para que la app pinte el
   * aviso en vez de montar la tienda.
   *
   * Se comprueba cuál es, y no solo cuántos hay: el guardián original exigía
   * exactamente uno para que a nadie se le colara un middleware por descuido.
   * Aflojarlo a «dos o menos» le quitaría los dientes; lo que se hace es
   * nombrar el que se añadió a propósito.
   */
  it('la portada solo añade el lector de bloqueo, y nada con sesión', () => {
    const ruta = rutas.find(r => r.path === PUBLICA)
    expect(ruta).toBeTruthy()
    expect(ruta.handlers).toBe(2)

    // Se mira SOLO la línea de la ruta, no un bloque del archivo: lo que se
    // afirma es qué middlewares lleva ESTA ruta, y un `slice` largo acaba
    // leyendo los de la siguiente.
    const fuente = fuenteDeLaTienda({ compilado: true })
    const desde = fuente.indexOf(`'${PUBLICA}'`)
    const linea = fuente.slice(desde, fuente.indexOf('\n', desde))
    expect(linea).toContain('readStorefrontBlock')
    // Y NO los que exigen o resuelven sesión: la portada es pública.
    expect(linea).not.toContain('requireStorefrontSession')
    expect(linea).not.toContain('readStorefrontSession,')
  })

  /**
   * El lector de bloqueo de la portada NUNCA rechaza.
   *
   * Es lo que permite que un bloqueado reciba el nombre y el logo del local
   * —y con eso un aviso que reconoce como suyo— en vez de un error pelado. La
   * defensa son los 403 de los otros dos middlewares, no este.
   */
  it('el lector de bloqueo de la portada no rechaza a nadie', () => {
    const fuente = fs.readFileSync('dist/middleware/storefront.js', 'utf8')
    // Desde su DEFINICIÓN, no desde la línea de exports del principio.
    const bloque = fuente.slice(fuente.indexOf('const readStorefrontBlock ='))
    expect(bloque).toContain('storefrontBlock')
    expect(bloque).not.toContain('reject(')
  })

  /**
   * Y los dos middlewares que SÍ defienden rechazan el bloqueo.
   *
   * Es la puerta que faltaba el 2026-08-29: la tienda no miraba el bloqueo en
   * ningún sitio, así que alguien bloqueado entró por un enlace viejo,
   * recorrió la carta y creó el pedido #74.
   */
  it('exigir y leer sesión rechazan a quien está bloqueado', () => {
    const fuente = fs.readFileSync('dist/middleware/storefront.js', 'utf8')
    // La comprobación vive en el resolutor COMÚN: una por ruta se olvida.
    const comun = fuente.slice(fuente.indexOf('const resolveStorefront ='))
    expect(comun).toContain('customerBlockState')
    expect(comun).toContain("reason: 'bloqueado'")

    const opcional = fuente.slice(fuente.indexOf('const readStorefrontSession ='))
    expect(opcional).toMatch(/reason === 'bloqueado'/)
  })

  /** El bloqueo es 403 y con plazo, no un 401 que mande a pedir otro enlace. */
  it('el bloqueo responde 403 y dice hasta cuándo', () => {
    const fuente = fs.readFileSync('dist/middleware/storefront.js', 'utf8')
    const bloque = fuente.slice(fuente.indexOf('const reject ='))
    expect(bloque).toContain('403')
    expect(bloque).toContain('until')
    expect(bloque).toContain('permanent')
  })

  // La verificación no lleva sesión, pero SÍ tiene que llevar freno: es donde
  // se adivinarían números de teléfono a lo bruto. Sin esto pasaría el
  // guardián de arriba por tener dos handlers, sin que el segundo protegiera
  // nada — un verde por accidente.
  it('la verificación del número va con rate limit propio', () => {
    const ruta = rutas.find(r => r.path === VERIFICACION)
    expect(ruta).toBeTruthy()
    expect(ruta.handlers).toBe(2)
    const fuente = fuenteDeLaTienda({ compilado: true })
    expect(fuente).toContain('verifyLimiter')
    // Ocho por minuto: suficiente para quien se equivoca escribiendo, inútil
    // para quien prueba números en serie.
    const bloque = fuente.slice(fuente.indexOf('verifyLimiter'))
    expect(bloque).toMatch(/max:\s*8/)
  })

  // El enlace corto es la puerta que se manda por WhatsApp: si algún día
  // devolviera datos en vez de redirigir, sería una tienda abierta a cualquiera
  // que pruebe tokens. Aquí se fija que su única salida es una redirección.
  it('el enlace corto solo redirige, nunca responde con datos', () => {
    const fuente = fuenteDeLaTienda({ compilado: true })
    const bloque = fuente.slice(fuente.indexOf("'/s/:code'"))
    const cuerpo = bloque.slice(0, bloque.indexOf('router.get(\'/api/store/:slug\''))
    expect(cuerpo).toContain('res.redirect')
    expect(cuerpo).not.toContain('res.json')
  })

  // Crear pedidos lleva su propio límite, más estricto que el general.
  it('crear pedido tiene un middleware extra de límite', () => {
    const pedidos = rutas.find(ruta => ruta.path === '/api/store/:slug/orders')
    const catalogo = rutas.find(ruta => ruta.path === '/api/store/:slug/catalog')
    expect(pedidos.handlers).toBeGreaterThan(catalogo.handlers)
  })

  it('el router aplica un límite de peticiones a todo /api/store', () => {
    const limitador = router.stack.find(
      layer => !layer.route && String(layer.regexp).includes('store'),
    )
    expect(limitador).toBeTruthy()
  })
})
