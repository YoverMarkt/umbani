import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fuenteDeLaPantalla } from './fuente-de-la-pantalla.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// «MIS PEDIDOS» CON UN ENLACE SIN CONFIRMAR PIDE EL NÚMERO, NO FALLA
// ═══════════════════════════════════════════════════════════════════════════
//
// 2026-09-25, en el repaso de todas las pantallas: abriendo el enlace en otro
// teléfono, «Mis pedidos» decía «No pudimos cargar tus pedidos». No era un
// fallo: el servidor contestaba que faltaba confirmar el número, y el resto de
// la tienda ya lo convertía en la pantalla de confirmar. Esta se lo tragaba.
//
// Se lee el código en vez de montarlo: la tienda prueba sus componentes sin
// navegador, y el efecto que carga los pedidos solo corre dentro de uno.

const leer = (ruta) => readFileSync(new URL(ruta, import.meta.url), 'utf8')

describe('la cuenta usa la misma puerta que el resto de la tienda', () => {
  it('los pedidos que no cargan pasan primero por onFalloEnlace', () => {
    const cuenta = leer('../src/screens/Account.tsx')
    const carga = cuenta.slice(cuenta.indexOf('getOrders(slug)'))
    const puerta = carga.indexOf('onFalloEnlace(fallo)')
    const error = carga.indexOf("setError('No pudimos cargar tus pedidos')")
    expect(puerta).toBeGreaterThan(-1)
    // La puerta va ANTES: solo si no era cosa del enlace se enseña el error.
    expect(puerta).toBeLessThan(error)
  })

  it('la tienda le pasa esa puerta a la cuenta', () => {
    const tienda = fuenteDeLaPantalla()
    const cuenta = tienda.slice(tienda.indexOf('<Account'), tienda.indexOf('/>', tienda.indexOf('<Account')))
    expect(cuenta).toContain('onFalloEnlace={onFalloEnlace}')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LOS TRES FALLOS QUE EL DUEÑO ENCONTRÓ EN PRODUCCIÓN (2026-09-26)
// ═══════════════════════════════════════════════════════════════════════════

describe('un acceso que no vale, en «Mis pedidos», lo DICE y manda a la app', () => {
  // Nació el 2026-09-26 como «después de confirmar el número, se vuelve a
  // pedir». La confirmación por WhatsApp se retiró el 2026-10-09 (Umbani es
  // solo app): lo que queda es lo que importaba al dueño — que la pantalla no
  // se quede en «Cargando…» para siempre, sino que diga qué falta.
  it('no se queda cargando: dice «Entra desde la app» con su botón', () => {
    const cuenta = leer('../src/screens/Account.tsx')
    expect(cuenta).toMatch(/\}, \[slug, onFalloEnlace, intento\]\)/)
    expect(cuenta).toMatch(/if \(await onFalloEnlace\(fallo\)\) \{\s*setSinAcceso\(true\)/)
    expect(cuenta).toContain('titulo="Entra desde la app"')
    expect(cuenta).toContain('href={DIRECCION_DE_UMBANI}')
    // Y ya no hay contador de sesiones que la tienda tenga que pasarle.
    const tienda = fuenteDeLaPantalla()
    const cuentaEnTienda = tienda.slice(tienda.indexOf('<Account'), tienda.indexOf('/>', tienda.indexOf('<Account')))
    expect(cuentaEnTienda).not.toContain('sesionesNuevas')
  })
})

describe('la barra de categorías sigue al scroll también al volver', () => {
  it('el vigilante se vuelve a armar cuando la carta reaparece', () => {
    const tienda = fuenteDeLaPantalla()
    expect(tienda).toMatch(/const cartaALaVista = !enCuenta && !\(pagoPendiente && abrirPago\) && !recienHecho/)
    // `resultados` salió de aquí el 2026-09-26: la búsqueda tiene su propia
    // pantalla y ya no sustituye a la carta. Lo que importa sigue siendo que
    // `cartaALaVista` rearme el vigilante.
    expect(tienda).toMatch(/\}, \[grupos, cartaALaVista\]\)/)
  })
})

describe('«Falta tu comprobante» no espera a recargar', () => {
  it('se vuelve a mirar al salir del pedido recibido y de la pantalla de pago', () => {
    const tienda = fuenteDeLaPantalla()
    expect(tienda).toContain('onVolver={() => { setRecienHecho(null); revisarPagoPendiente() }}')
    expect(tienda).toContain('onVolver={() => { setAbrirPago(false); revisarPagoPendiente() }}')
    // Y se apaga cuando ya no debe nada, no solo se enciende.
    expect(tienda).toContain('setPagoPendiente(debe ? pedido : null)')
  })
})
