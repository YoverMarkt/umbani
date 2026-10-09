import { describe, expect, it } from 'vitest'
import { PARTES_DE_LA_PANTALLA, fuenteDeLaPantalla, partesQueImportaLaTienda } from './fuente-de-la-pantalla.mjs'

// La lista de `fuente-de-la-pantalla.mjs` es lo que hace que las pruebas que
// leen la tienda como texto no pasen en vacío. Si miente, ellas también.

describe('las pruebas leen la pantalla de la tienda ENTERA', () => {
  it('cada bloque de la lista lo importa de verdad FoodStore', () => {
    expect(partesQueImportaLaTienda()).toEqual(PARTES_DE_LA_PANTALLA.slice(1))
  })

  it('y la lectura trae lo de FoodStore y lo de los bloques', () => {
    const pantalla = fuenteDeLaPantalla()
    expect(pantalla).toContain('export default function FoodStore(')
    for (const parte of PARTES_DE_LA_PANTALLA.slice(1)) {
      const nombre = parte.split('/').pop().replace('.tsx', '')
      expect(pantalla, nombre).toContain(`export function ${nombre}(`)
    }
  })
})
