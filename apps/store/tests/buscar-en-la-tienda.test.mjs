import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// ═══════════════════════════════════════════════════════════════════════════
// LA TIENDA ABRE LA PANTALLA DE BUSCAR DE VERDAD (2026-09-26)
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ En `.mjs` y no dentro de `buscar.test.tsx`, a propósito: `tsc -b` de la
// tienda compila también las pruebas, y la tienda no tiene los tipos de Node.
// Un `node:fs` en un `.tsx` rompe `npm run build` de la mini app —lo cazó el
// staging al construirla—. Es la misma razón por la que ya existe
// `cuenta-sin-confirmar.test.mjs`.

describe('la tienda abre la pantalla de verdad', () => {
  const tienda = readFileSync(new URL('../src/screens/FoodStore.tsx', import.meta.url), 'utf8')

  it('viaja en su propio trozo, fuera del presupuesto de la carta', () => {
    expect(tienda).toContain("const Buscar = lazy(() => import('./Buscar'))")
    expect(tienda).toContain("void import('./Buscar')")
  })

  it('la barra vieja dentro de la portada ya no existe', () => {
    expect(tienda).not.toContain('¿Qué se te antoja?')
    expect(tienda).not.toMatch(/setBusqueda|resultados\.map/)
  })

  it('«Buscar» enfoca el campo escondido DENTRO del toque, antes de abrir', () => {
    // iOS solo abre el teclado si el foco llega dentro del toque.
    const accion = tienda.slice(tienda.indexOf("id: 'buscar'"), tienda.indexOf("id: 'carrito'"))
    const foco = accion.indexOf('enfocarAntes.current?.focus()')
    const abrir = accion.indexOf('setBuscando(true)')
    expect(foco).toBeGreaterThan(-1)
    expect(abrir).toBeGreaterThan(foco)
    expect(accion).not.toContain('requestAnimationFrame')
  })

  it('el campo escondido se puede enfocar: nada de display none', () => {
    const campo = tienda.slice(tienda.indexOf('ref={enfocarAntes}') - 40, tienda.indexOf('ref={enfocarAntes}') + 200)
    expect(campo).toContain('opacity-0')
    expect(campo).not.toMatch(/\bhidden\b(?!=)/)
  })
})
