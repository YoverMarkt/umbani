import { readFileSync } from 'node:fs'

// ═══════════════════════════════════════════════════════════════════════════
// LA PANTALLA DE LA TIENDA, ENTERA, PARA LAS PRUEBAS QUE LA LEEN COMO TEXTO
// ═══════════════════════════════════════════════════════════════════════════
//
// Hasta el 2026-10-08 la pantalla vivía entera en `screens/FoodStore.tsx`. Ese
// día cuatro de sus bloques se mudaron a `components/` (ningún archivo pasa de
// 1.000 líneas), y la prueba de «Buscar» falló porque seguía leyendo solo
// FoodStore. Que fallara fue la suerte: un «no contiene X» habría pasado en
// verde aunque X estuviera en uno de los bloques mudados.
//
// Por eso las pruebas leen la pantalla ENTERA. Si se saca otro bloque, se
// añade aquí; la propia lista se comprueba contra los imports de FoodStore.

export const PARTES_DE_LA_PANTALLA = [
  'screens/FoodStore.tsx',
  'components/HeroeDeLaTienda.tsx',
  'components/ServicioDeLaTienda.tsx',
  'components/TarjetaDeProducto.tsx',
  'components/PieDeLaTienda.tsx',
]

const leer = (parte) => readFileSync(new URL(`../src/${parte}`, import.meta.url), 'utf8')

export const fuenteDeLaPantalla = () => PARTES_DE_LA_PANTALLA.map(leer).join('\n')

// Las partes que FoodStore importa de verdad: si un bloque deja de usarse, la
// lista miente y la prueba que la recorre lo dice.
export const partesQueImportaLaTienda = () => {
  const tienda = leer('screens/FoodStore.tsx')
  return PARTES_DE_LA_PANTALLA.slice(1).filter((parte) => {
    const nombre = parte.split('/').pop().replace('.tsx', '')
    return tienda.includes(`import { ${nombre} } from '../${parte.replace('.tsx', '')}'`)
  })
}
